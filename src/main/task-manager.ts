import { nanoid } from 'nanoid'
import type { CreateTaskInput, PreviewResult, ResolveProgress, TaskRecord } from '../shared/contracts'
import type { AppDatabase } from './database'
import type { PixivClient } from './pixiv'
import { PixivError } from './pixiv'
import type { ArtworkDownloader } from './downloader'
import { DownloadError } from './downloader'
import type { SettingsStore } from './settings'
import { retryDelay, sleep } from '../shared/utils'

type Listener = (task: TaskRecord) => void

export class TaskManager {
  private readonly runs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  constructor(
    private readonly db: AppDatabase, private readonly pixiv: PixivClient,
    private readonly downloader: ArtworkDownloader, private readonly settings: SettingsStore,
    private readonly emit: Listener
  ) {}

  async preview(input: CreateTaskInput): Promise<PreviewResult> {
    const works = await this.pixiv.resolveSource(input.source, input.filters)
    return { count: works.length, imageCount: works.reduce((total, work) => total + Math.max(1, work.pages.length), 0), sample: works.slice(0, 12).map((w) => ({ id: w.id, title: w.title, authorName: w.userName, type: w.type })), warnings: works.length === 0 ? ['没有作品符合筛选条件'] : [] }
  }
  create(input: CreateTaskInput): TaskRecord {
    const task = this.db.createTask(nanoid(), input)
    void this.start(task.id)
    return task
  }
  list(): TaskRecord[] { return this.db.listTasks() }
  async pause(id: string): Promise<void> {
    const active = this.runs.get(id)
    active?.controller.abort()
    if (active) await active.promise
    const task = this.db.getTask(id)
    if (task && !['completed', 'canceled'].includes(task.status)) this.change(id, { status: 'paused', message: '已暂停，可从当前进度继续' })
  }
  async cancel(id: string): Promise<void> {
    const active = this.runs.get(id)
    active?.controller.abort()
    if (active) await active.promise
    const task = this.db.getTask(id)
    if (task && task.status !== 'completed') this.change(id, { status: 'canceled', message: '已取消' })
  }
  resume(id: string): void { const task = this.db.getTask(id); if (task && ['paused', 'failed', 'partial'].includes(task.status)) void this.start(id) }
  retry(id: string): void {
    const task = this.db.getTask(id)
    if (task && ['failed', 'partial'].includes(task.status)) this.change(id, { failed: 0, message: '正在重试失败项目' })
    this.resume(id)
  }

  private start(id: string): Promise<void> {
    const active = this.runs.get(id)
    if (active) return active.promise
    const controller = new AbortController()
    const promise = this.run(id, controller).finally(() => { if (this.runs.get(id)?.controller === controller) this.runs.delete(id) })
    this.runs.set(id, { controller, promise })
    return promise
  }
  private async run(id: string, controller: AbortController): Promise<void> {
    try {
      let task = this.db.getTask(id)
      if (!task) return
      let pending = this.db.listPendingItems(id)
      if (task.total === 0 || pending.length === 0 && task.completed === 0) {
        this.change(id, { status: 'resolving', message: task.inspectedCandidates > 0 ? '正在从已保存进度继续解析' : '正在解析来源' })
        const legacyFloor = { inspected: task.inspectedCandidates, matched: task.matchedImages }
        let latestProgress: ResolveProgress | undefined
        let lastProgressAt = 0
        const reportProgress = (progress: ResolveProgress): void => {
          const visible = progress.inspectedCandidates < legacyFloor.inspected
            ? { ...progress, inspectedCandidates: legacyFloor.inspected, matchedImages: Math.max(progress.matchedImages, legacyFloor.matched) }
            : progress
          latestProgress = visible
          if (controller.signal.aborted || Date.now() - lastProgressAt < 250) return
          lastProgressAt = Date.now()
          this.change(id, { ...visible, message: `已检查 ${visible.inspectedCandidates}/${visible.candidateTotal}、匹配 ${visible.matchedImages} 张` })
        }
        await this.pixiv.resolveSource(task.source, task.filters, controller.signal, reportProgress, {
          checkpoint: this.db.getResolution(id),
          onCheckpoint: (checkpoint) => this.db.setResolution(id, checkpoint),
          onAccepted: (work) => { this.db.saveArtwork(work); this.db.addItems(id, [work.id]) }
        })
        if (latestProgress && !controller.signal.aborted) {
          this.change(id, { ...latestProgress, message: `已检查 ${latestProgress.inspectedCandidates}/${latestProgress.candidateTotal}、匹配 ${latestProgress.matchedImages} 张` })
        }
        this.db.clearResolution(id)
        pending = this.db.listPendingItems(id)
        const counts = this.db.itemCounts(id)
        task = this.change(id, { status: 'queued', ...counts, message: `已找到 ${counts.total} 个作品` })
      }
      if (pending.length === 0) { this.change(id, { status: 'completed', message: '没有需要下载的作品' }); return }
      this.change(id, { status: 'downloading', message: '开始下载' })
      const workers = Array.from({ length: Math.min(this.settings.get().concurrency, pending.length) }, () => this.worker(id, pending, controller.signal))
      await Promise.all(workers)
      const final = this.db.getTask(id)!
      if (final.status === 'paused' || final.status === 'canceled') return
      this.change(id, { status: final.failed > 0 ? 'partial' : 'completed', message: final.failed > 0 ? '部分作品下载失败，可重试' : '下载完成' })
    } catch (error) {
      const current = this.db.getTask(id)
      if (controller.signal.aborted || current?.status === 'paused' || current?.status === 'canceled') return
      const auth = error instanceof PixivError && error.code === 'auth' || error instanceof DownloadError && error.code === 'auth'
      this.change(id, { status: auth ? 'paused' : 'failed', message: error instanceof Error ? error.message : '任务失败' })
    }
  }
  private async worker(taskId: string, queue: string[], signal: AbortSignal): Promise<void> {
    while (queue.length) {
      signal.throwIfAborted()
      const artworkId = queue.shift()
      if (!artworkId) return
      try {
        this.db.setItem(taskId, artworkId, 'downloading')
        const task = this.db.getTask(taskId)!
        const cached = this.db.getArtwork(artworkId)
        const artwork = cached ?? await this.pixiv.getArtwork(artworkId, signal)
        if (!cached) this.db.saveArtwork(artwork)
        await this.downloadWithRetry(taskId, artwork, task.force, signal)
        this.db.setItem(taskId, artworkId, 'completed')
        this.change(taskId, this.db.itemCounts(taskId))
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof PixivError && error.code === 'auth' || error instanceof DownloadError && error.code === 'auth') throw error
        this.db.setItem(taskId, artworkId, 'failed', error instanceof Error ? error.message : '下载失败')
        const exhausted = this.retryable(error)
        this.change(taskId, { ...this.db.itemCounts(taskId), message: exhausted ? `${artworkId} 自动重试 3 次后仍下载失败` : error instanceof Error ? error.message : `${artworkId} 下载失败` })
      }
    }
  }
  private async downloadWithRetry(taskId: string, artwork: NonNullable<ReturnType<AppDatabase['getArtwork']>>, force: boolean, signal: AbortSignal): Promise<void> {
    const attempts = 4
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.downloader.download(taskId, artwork, this.settings.get().downloadRoot, force, signal, (progress) => {
          this.change(taskId, { status: artwork.type === 'ugoira' && progress.done === progress.total ? 'converting' : 'downloading', message: `${artwork.title}：${progress.message}` })
        })
        return
      } catch (error) {
        if (signal.aborted || !this.retryable(error) || attempt === attempts - 1) throw error
        const wait = error instanceof DownloadError && error.retryAfterMs !== undefined ? error.retryAfterMs : retryDelay(attempt)
        this.change(taskId, { message: `${artwork.title} 下载中断，${Math.ceil(wait / 1000)} 秒后自动重试（${attempt + 1}/3）` })
        await sleep(wait, signal)
      }
    }
  }
  private retryable(error: unknown): boolean {
    if (error instanceof DownloadError) return error.retryable
    if (error instanceof PixivError) return error.code === 'network' || error.code === 'rate-limit'
    const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
    return !['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(code)
  }
  private change(id: string, patch: Parameters<AppDatabase['updateTask']>[1]): TaskRecord { const task = this.db.updateTask(id, patch); this.emit(task); return task }
}
