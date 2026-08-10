import { z } from 'zod'
import type { Session } from 'electron'
import type { AuthService } from './auth'
import type { DownloadFilter, DownloadSource, PixivArtwork, PixivPage, ResolveProgress, UgoiraFrame } from '../shared/contracts'
import { parseArtworkId, parseSearchKeyword, parseUserId, retryDelay, sleep, upperJitter } from '../shared/utils'

const ajaxSchema = z.object({ error: z.boolean(), message: z.string().optional(), body: z.unknown().optional() })
const artworkSchema = z.object({
  illustId: z.coerce.string(), illustTitle: z.string(), illustComment: z.string().default(''), userId: z.coerce.string(), userName: z.string(),
  illustType: z.number(), createDate: z.string(), uploadDate: z.string().optional(), aiType: z.number().optional(), xRestrict: z.number().optional(),
  pageCount: z.coerce.number().int().min(1).catch(1),
  bookmarkCount: z.coerce.number().catch(0), viewCount: z.coerce.number().catch(0), likeCount: z.coerce.number().catch(0),
  tags: z.object({ tags: z.array(z.object({ tag: z.string() })) })
})
const pagesSchema = z.array(z.object({ urls: z.object({ original: z.string() }), width: z.number().optional(), height: z.number().optional() }))
const ugoiraSchema = z.object({ originalSrc: z.string(), frames: z.array(z.object({ file: z.string(), delay: z.number() })) })
const searchWorkSchema = z.object({
  id: z.coerce.string(), illustType: z.number(), xRestrict: z.number().catch(0),
  tags: z.array(z.string()).catch([]), createDate: z.string(), aiType: z.number().catch(0),
  pageCount: z.coerce.number().int().min(1).catch(1), bookmarkCount: z.coerce.number().optional(),
  viewCount: z.coerce.number().optional(), likeCount: z.coerce.number().optional()
})
const searchSchema = z.object({
  illustManga: z.object({
    data: z.array(searchWorkSchema),
    total: z.number()
  })
})
type ArtworkDetail = z.infer<typeof artworkSchema>
type SearchWork = z.infer<typeof searchWorkSchema>
const searchCandidatesSchema = z.object({
  candidates: z.array(z.object({
    tag_name: z.string(), tag_translation: z.string().nullable().optional()
  }))
})

export class PixivError extends Error { constructor(message: string, readonly code: 'auth' | 'not-found' | 'rate-limit' | 'adapter' | 'network') { super(message) } }

export function pickTranslatedTag(word: string, candidates: { tag_name: string; tag_translation?: string | null }[]): string {
  const normalized = word.toLocaleLowerCase()
  const exact = candidates.find((candidate) =>
    candidate.tag_name.toLocaleLowerCase() === normalized || candidate.tag_translation?.toLocaleLowerCase() === normalized)
  return exact?.tag_name ?? word
}

export function matchesArtwork(work: PixivArtwork, filter: DownloadFilter): boolean {
  if (!matchesCommon(work, filter)) return false
  if (work.bookmarkCount < filter.minBookmarks) return false
  if (work.viewCount < filter.minViews) return false
  if (work.likeCount < filter.minLikes) return false
  return true
}

function matchesCommon(work: Pick<PixivArtwork, 'type' | 'createDate' | 'tags' | 'aiType' | 'xRestrict'>, filter: DownloadFilter): boolean {
  if (!filter.types.includes(work.type)) return false
  const date = work.createDate.slice(0, 10)
  if (filter.dateFrom && date < filter.dateFrom) return false
  if (filter.dateTo && date > filter.dateTo) return false
  const tags = new Set(work.tags.map((t) => t.toLocaleLowerCase()))
  if (filter.includeTags.length && !filter.includeTags.every((t) => tags.has(t.toLocaleLowerCase()))) return false
  if (filter.excludeTags.some((t) => tags.has(t.toLocaleLowerCase()))) return false
  if (filter.ai === 'exclude' && work.aiType === 2) return false
  if (filter.ai === 'only' && work.aiType !== 2) return false
  if (filter.age === 'safe' && work.xRestrict !== 0) return false
  if (filter.age === 'r18' && work.xRestrict === 0) return false
  return true
}

export function matchesSearchSummary(work: SearchWork, filter: DownloadFilter): boolean {
  return matchesCommon({
    type: artworkType(work.illustType), createDate: work.createDate, tags: work.tags,
    aiType: work.aiType, xRestrict: work.xRestrict
  }, filter)
}

function artworkType(value: number): PixivArtwork['type'] { return value === 2 ? 'ugoira' : value === 1 ? 'manga' : 'illust' }

function matchesArtworkDetail(work: ArtworkDetail, filter: DownloadFilter): boolean {
  return matchesCommon({
    type: artworkType(work.illustType), createDate: work.createDate,
    tags: work.tags.tags.map((tag) => tag.tag), aiType: work.aiType ?? 0, xRestrict: work.xRestrict ?? 0
  }, filter) && work.bookmarkCount >= filter.minBookmarks && work.viewCount >= filter.minViews && work.likeCount >= filter.minLikes
}

export class PixivClient {
  private lastRequest = 0
  private cooldownUntil = 0
  private activeRequests = 0
  private readonly requestWaiters: Array<() => void> = []
  private requestGate: Promise<void> = Promise.resolve()
  constructor(
    private readonly auth: AuthService, private readonly interval: () => number,
    private readonly concurrency: () => number = () => 4
  ) {}
  private get session(): Session { return this.auth.session }

  async configureProxy(mode: 'system' | 'custom', proxyUrl: string): Promise<void> {
    await this.session.setProxy(mode === 'system' ? { mode: 'system' } : { mode: 'fixed_servers', proxyRules: proxyUrl })
    await this.session.closeAllConnections()
  }

  async testConnection(): Promise<number> {
    const started = Date.now()
    const response = await this.session.fetch('https://www.pixiv.net/', { method: 'HEAD' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Date.now() - started
  }

  async resolveSource(source: DownloadSource, filters: DownloadFilter, signal?: AbortSignal, onProgress?: (progress: ResolveProgress) => void): Promise<PixivArtwork[]> {
    if (source.kind === 'search') return this.resolveSearch(source.value, source.maxImages, filters, signal, onProgress)
    let ids: string[]
    if (source.kind === 'artworks') {
      ids = source.values.map(parseArtworkId).filter((id): id is string => Boolean(id))
      if (ids.length !== source.values.length) throw new PixivError('包含无效的 Pixiv 作品链接或 ID', 'adapter')
    } else if (source.kind === 'author') {
      const userId = parseUserId(source.value)
      if (!userId) throw new PixivError('作者链接或 ID 无效', 'adapter')
      ids = await this.authorIds(userId, signal)
    } else {
      const status = await this.auth.getStatus()
      if (!status.loggedIn || !status.userId) throw new PixivError('请先登录 Pixiv', 'auth')
      ids = await this.bookmarkIds(status.userId, filters.bookmarkVisibility, signal)
    }
    const unique = [...new Set(ids)]
    const results: PixivArtwork[] = []
    for (const id of unique) {
      signal?.throwIfAborted()
      try {
        const artwork = await this.getArtwork(id, signal)
        if (matchesArtwork(artwork, filters)) results.push(artwork)
      } catch (error) { if (!(error instanceof PixivError) || error.code !== 'not-found') throw error }
    }
    return results
  }

  async getArtwork(id: string, signal?: AbortSignal): Promise<PixivArtwork> {
    return this.hydrateArtwork(await this.getArtworkDetail(id, signal), signal)
  }

  private async getArtworkDetail(id: string, signal?: AbortSignal): Promise<ArtworkDetail> {
    const parsed = artworkSchema.safeParse(await this.getBody(`/ajax/illust/${id}?lang=zh`, signal))
    if (!parsed.success) throw new PixivError('Pixiv 作品详情结构已变化，请更新站点适配器', 'adapter')
    return parsed.data
  }

  private async hydrateArtwork(raw: ArtworkDetail, signal?: AbortSignal): Promise<PixivArtwork> {
    const id = raw.illustId
    const pagesRaw = pagesSchema.parse(await this.getBody(`/ajax/illust/${id}/pages?lang=zh`, signal))
    const pages: PixivPage[] = pagesRaw.map((page, index) => ({ index, original: page.urls.original, width: page.width, height: page.height }))
    const type = artworkType(raw.illustType)
    let ugoira: { originalSrc: string; frames: UgoiraFrame[] } | undefined
    if (type === 'ugoira') ugoira = ugoiraSchema.parse(await this.getBody(`/ajax/illust/${id}/ugoira_meta?lang=zh`, signal))
    return {
      id: raw.illustId, title: raw.illustTitle, description: raw.illustComment,
      userId: raw.userId, userName: raw.userName, type, tags: raw.tags.tags.map((t) => t.tag),
      createDate: raw.createDate, uploadDate: raw.uploadDate ?? raw.createDate, aiType: raw.aiType ?? 0,
      xRestrict: raw.xRestrict ?? 0, bookmarkCount: raw.bookmarkCount, viewCount: raw.viewCount, likeCount: raw.likeCount,
      sourceUrl: `https://www.pixiv.net/artworks/${id}`, pages, ugoira
    }
  }

  private async authorIds(userId: string, signal?: AbortSignal): Promise<string[]> {
    const body = z.object({ illusts: z.record(z.string(), z.unknown()).nullable().optional(), manga: z.record(z.string(), z.unknown()).nullable().optional() })
      .parse(await this.getBody(`/ajax/user/${userId}/profile/all?lang=zh`, signal))
    return [...Object.keys(body.illusts ?? {}), ...Object.keys(body.manga ?? {})]
  }
  private async resolveSearch(
    input: string, maxImages: number, filters: DownloadFilter, signal?: AbortSignal,
    onProgress?: (progress: ResolveProgress) => void
  ): Promise<PixivArtwork[]> {
    const parsedWord = parseSearchKeyword(input)
    if (!parsedWord) throw new PixivError('请输入关键词或有效的 Pixiv 标签链接', 'adapter')
    const word = await this.resolveTranslatedTag(parsedWord, signal)
    const encoded = encodeURIComponent(word)
    const results: PixivArtwork[] = []
    const seen = new Set<string>()
    let imageCount = 0
    let inspected = 0
    let candidateTotal = 500
    const candidateLimit = 500
    for (let page = 1; inspected < candidateLimit && imageCount < maxImages; page++) {
      const query = new URLSearchParams({ word, order: 'date_d', mode: 'all', p: String(page), s_mode: 's_tag', type: 'all', lang: 'zh' })
      const parsed = searchSchema.safeParse(await this.getBody(`/ajax/search/artworks/${encoded}?${query}`, signal))
      if (!parsed.success) throw new PixivError('Pixiv 搜索接口结构已变化，请更新站点适配器', 'adapter')
      const body = parsed.data
      candidateTotal = Math.min(body.illustManga.total, candidateLimit)
      onProgress?.({ inspectedCandidates: inspected, candidateTotal, matchedImages: imageCount })
      const batch = body.illustManga.data.filter((work) => !seen.has(work.id)).slice(0, candidateLimit - inspected)
      batch.forEach((work) => seen.add(work.id))
      const completed = new Map<number, ArtworkDetail | null>()
      const accepted: ArtworkDetail[] = []
      let nextCommit = 0
      const commitReady = (): void => {
        while (completed.has(nextCommit)) {
          const detail = completed.get(nextCommit) ?? null
          completed.delete(nextCommit); nextCommit += 1
          if (detail && detail.pageCount <= maxImages - imageCount) {
            accepted.push(detail)
            imageCount += detail.pageCount
          }
        }
      }
      await this.runConcurrent(batch, async (candidate, index) => {
        let detail: ArtworkDetail | null = null
        const popularityMatches =
          (candidate.bookmarkCount === undefined || candidate.bookmarkCount >= filters.minBookmarks) &&
          (candidate.viewCount === undefined || candidate.viewCount >= filters.minViews) &&
          (candidate.likeCount === undefined || candidate.likeCount >= filters.minLikes)
        if (matchesSearchSummary(candidate, filters) && popularityMatches) {
          try {
            const value = await this.getArtworkDetail(candidate.id, signal)
            if (matchesArtworkDetail(value, filters)) detail = value
          } catch (error) { if (!(error instanceof PixivError) || error.code !== 'not-found') throw error }
        }
        completed.set(index, detail)
        inspected += 1
        commitReady()
        onProgress?.({ inspectedCandidates: inspected, candidateTotal, matchedImages: imageCount })
      }, signal, () => imageCount >= maxImages)
      const hydrated = new Array<PixivArtwork>(accepted.length)
      await this.runConcurrent(accepted, async (detail, index) => {
        hydrated[index] = await this.hydrateArtwork(detail, signal)
      }, signal)
      results.push(...hydrated)
      if (batch.length === 0 || seen.size >= body.illustManga.total) break
    }
    onProgress?.({ inspectedCandidates: inspected, candidateTotal, matchedImages: imageCount })
    return results
  }
  private async runConcurrent<T>(
    items: T[], worker: (item: T, index: number) => Promise<void>, signal?: AbortSignal,
    shouldStop: () => boolean = () => false
  ): Promise<void> {
    let next = 0
    const run = async (): Promise<void> => {
      while (!shouldStop()) {
        signal?.throwIfAborted()
        const index = next
        if (index >= items.length) return
        next += 1
        await worker(items[index]!, index)
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency(), items.length) }, run))
  }
  private async resolveTranslatedTag(word: string, signal?: AbortSignal): Promise<string> {
    const parsed = searchCandidatesSchema.safeParse(await this.getJson(`/rpc/cps.php?keyword=${encodeURIComponent(word)}&lang=zh`, signal))
    if (!parsed.success) return word
    return pickTranslatedTag(word, parsed.data.candidates)
  }
  private async bookmarkIds(userId: string, visibility: 'show' | 'hide' | 'both', signal?: AbortSignal): Promise<string[]> {
    const ids: string[] = []
    const scopes = visibility === 'both' ? ['show', 'hide'] : [visibility]
    for (const rest of scopes) {
      for (let offset = 0; ; offset += 48) {
        const body = z.object({ works: z.array(z.object({ id: z.coerce.string() })), total: z.number() })
          .parse(await this.getBody(`/ajax/user/${userId}/illusts/bookmarks?tag=&offset=${offset}&limit=48&rest=${rest}&lang=zh`, signal))
        ids.push(...body.works.map((work) => work.id))
        if (offset + body.works.length >= body.total || body.works.length === 0) break
      }
    }
    return ids
  }
  private async getBody(path: string, signal?: AbortSignal): Promise<unknown> {
    const envelope = ajaxSchema.safeParse(await this.getJson(path, signal))
    if (!envelope.success) throw new PixivError('Pixiv 返回结构已变化，请更新站点适配器', 'adapter')
    if (envelope.data.error) throw new PixivError(envelope.data.message || 'Pixiv 返回错误', 'adapter')
    return envelope.data.body
  }
  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted()
      await this.acquireRequest(signal)
      let retryMs = 0
      try {
        await this.pace(signal)
        const response = await this.session.fetch(`https://www.pixiv.net${path}`, { signal, headers: { Referer: 'https://www.pixiv.net/', Accept: 'application/json' } })
        if (response.status === 401 || response.status === 403) throw new PixivError('登录已失效或作品无权访问', 'auth')
        if (response.status === 404) throw new PixivError('作品不存在或已删除', 'not-found')
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 4) throw new PixivError(`Pixiv 暂时不可用（HTTP ${response.status}）`, response.status === 429 ? 'rate-limit' : 'network')
          retryMs = retryDelay(attempt, response.status, response.headers.get('retry-after'))
          if (response.status === 429) this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryMs)
        } else {
          if (!response.ok) throw new PixivError(`Pixiv 请求失败（HTTP ${response.status}）`, 'network')
          return await response.json()
        }
      } catch (error) {
        if (error instanceof PixivError || signal?.aborted) throw error
        if (attempt === 4) throw new PixivError(error instanceof Error ? error.message : '网络连接失败', 'network')
        retryMs = retryDelay(attempt)
      } finally {
        this.releaseRequest()
      }
      await sleep(retryMs, signal)
    }
    throw new PixivError('网络连接失败', 'network')
  }
  private async acquireRequest(signal?: AbortSignal): Promise<void> {
    if (this.activeRequests < this.concurrency()) { this.activeRequests += 1; return }
    await new Promise<void>((resolve, reject) => {
      const ready = (): void => { cleanup(); this.activeRequests += 1; resolve() }
      const aborted = (): void => { this.requestWaiters.splice(this.requestWaiters.indexOf(ready), 1); cleanup(); reject(signal?.reason) }
      const cleanup = (): void => signal?.removeEventListener('abort', aborted)
      this.requestWaiters.push(ready)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  }
  private releaseRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
    if (this.activeRequests < this.concurrency()) this.requestWaiters.shift()?.()
  }
  private async pace(signal?: AbortSignal): Promise<void> {
    const previous = this.requestGate
    let release = (): void => undefined
    this.requestGate = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const wait = Math.max(0, this.lastRequest + upperJitter(this.interval()) - Date.now(), this.cooldownUntil - Date.now())
      if (wait) await sleep(wait, signal)
      this.lastRequest = Date.now()
    } finally { release() }
  }
}
