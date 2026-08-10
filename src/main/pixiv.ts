import { z } from 'zod'
import type { Session } from 'electron'
import type { AuthService } from './auth'
import type { DownloadFilter, DownloadSource, PixivArtwork, PixivPage, UgoiraFrame } from '../shared/contracts'
import { jitter, parseArtworkId, parseUserId, retryDelay, sleep } from '../shared/utils'

const ajaxSchema = z.object({ error: z.boolean(), message: z.string().optional(), body: z.unknown().optional() })
const artworkSchema = z.object({
  illustId: z.coerce.string(), illustTitle: z.string(), illustComment: z.string().default(''), userId: z.coerce.string(), userName: z.string(),
  illustType: z.number(), createDate: z.string(), uploadDate: z.string().optional(), aiType: z.number().optional(), xRestrict: z.number().optional(),
  tags: z.object({ tags: z.array(z.object({ tag: z.string() })) })
})
const pagesSchema = z.array(z.object({ urls: z.object({ original: z.string() }), width: z.number().optional(), height: z.number().optional() }))
const ugoiraSchema = z.object({ originalSrc: z.string(), frames: z.array(z.object({ file: z.string(), delay: z.number() })) })

export class PixivError extends Error { constructor(message: string, readonly code: 'auth' | 'not-found' | 'rate-limit' | 'adapter' | 'network') { super(message) } }

export function matchesArtwork(work: PixivArtwork, filter: DownloadFilter): boolean {
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

export class PixivClient {
  private lastRequest = 0
  private requestGate: Promise<void> = Promise.resolve()
  constructor(private readonly auth: AuthService, private readonly interval: () => number) {}
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

  async resolveSource(source: DownloadSource, filters: DownloadFilter, signal?: AbortSignal): Promise<PixivArtwork[]> {
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
    const raw = artworkSchema.parse(await this.getBody(`/ajax/illust/${id}?lang=zh`, signal))
    const pagesRaw = pagesSchema.parse(await this.getBody(`/ajax/illust/${id}/pages?lang=zh`, signal))
    const pages: PixivPage[] = pagesRaw.map((page, index) => ({ index, original: page.urls.original, width: page.width, height: page.height }))
    const type = raw.illustType === 2 ? 'ugoira' : raw.illustType === 1 ? 'manga' : 'illust'
    let ugoira: { originalSrc: string; frames: UgoiraFrame[] } | undefined
    if (type === 'ugoira') ugoira = ugoiraSchema.parse(await this.getBody(`/ajax/illust/${id}/ugoira_meta?lang=zh`, signal))
    return {
      id: raw.illustId, title: raw.illustTitle, description: raw.illustComment,
      userId: raw.userId, userName: raw.userName, type, tags: raw.tags.tags.map((t) => t.tag),
      createDate: raw.createDate, uploadDate: raw.uploadDate ?? raw.createDate, aiType: raw.aiType ?? 0,
      xRestrict: raw.xRestrict ?? 0, sourceUrl: `https://www.pixiv.net/artworks/${id}`, pages, ugoira
    }
  }

  private async authorIds(userId: string, signal?: AbortSignal): Promise<string[]> {
    const body = z.object({ illusts: z.record(z.string(), z.unknown()).nullable().optional(), manga: z.record(z.string(), z.unknown()).nullable().optional() })
      .parse(await this.getBody(`/ajax/user/${userId}/profile/all?lang=zh`, signal))
    return [...Object.keys(body.illusts ?? {}), ...Object.keys(body.manga ?? {})]
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
    for (let attempt = 0; attempt < 5; attempt++) {
      signal?.throwIfAborted()
      await this.pace(signal)
      try {
        const response = await this.session.fetch(`https://www.pixiv.net${path}`, { signal, headers: { Referer: 'https://www.pixiv.net/', Accept: 'application/json' } })
        if (response.status === 401 || response.status === 403) throw new PixivError('登录已失效或作品无权访问', 'auth')
        if (response.status === 404) throw new PixivError('作品不存在或已删除', 'not-found')
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 4) throw new PixivError(`Pixiv 暂时不可用（HTTP ${response.status}）`, response.status === 429 ? 'rate-limit' : 'network')
          await sleep(retryDelay(attempt, response.status, response.headers.get('retry-after')), signal); continue
        }
        if (!response.ok) throw new PixivError(`Pixiv 请求失败（HTTP ${response.status}）`, 'network')
        const envelope = ajaxSchema.safeParse(await response.json())
        if (!envelope.success) throw new PixivError('Pixiv 返回结构已变化，请更新站点适配器', 'adapter')
        if (envelope.data.error) throw new PixivError(envelope.data.message || 'Pixiv 返回错误', 'adapter')
        return envelope.data.body
      } catch (error) {
        if (error instanceof PixivError || signal?.aborted) throw error
        if (attempt === 4) throw new PixivError(error instanceof Error ? error.message : '网络连接失败', 'network')
        await sleep(retryDelay(attempt), signal)
      }
    }
    throw new PixivError('网络连接失败', 'network')
  }
  private async pace(signal?: AbortSignal): Promise<void> {
    const previous = this.requestGate
    let release = (): void => undefined
    this.requestGate = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const wait = Math.max(0, this.lastRequest + jitter(this.interval()) - Date.now())
      if (wait) await sleep(wait, signal)
      this.lastRequest = Date.now()
    } finally { release() }
  }
}
