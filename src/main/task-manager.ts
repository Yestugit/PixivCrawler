import { nanoid } from 'nanoid'
import type { CreateTaskInput, PreviewResult, TaskRecord } from '../shared/contracts'
import type { AppDatabase } from './database'
import type { PixivClient } from './pixiv'
import { PixivError } from './pixiv'
import type { ArtworkDownloader } from './downloader'
import type { SettingsStore } from './settings'

type Listener = (task: TaskRecord) => void

export class TaskManager {
  private readonly controllers = new Map<string, AbortController>()
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
    void this.run(task.id)
    return task
  }
  list(): TaskRecord[] { return this.db.listTasks() }
  pause(id: string): void { this.controllers.get(id)?.abort(); this.change(id, { status: 'paused', message: '已暂停' }) }
  cancel(id: string): void { this.controllers.get(id)?.abort(); this.change(id, { status: 'canceled', message: '已取消' }) }
  resume(id: string): void { const task = this.db.getTask(id); if (task && ['paused', 'failed', 'partial'].includes(task.status)) void this.run(id) }
  retry(id: string): void {
    const task = this.db.getTask(id)
    if (task && ['failed', 'partial'].includes(task.status)) this.change(id, { failed: 0, message: '正在重试失败项目' })
    this.resume(id)
  }

  private async run(id: string): Promise<void> {
    if (this.controllers.has(id)) return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    try {
      let task = this.db.getTask(id)
      if (!task) return
      let pending = this.db.listPendingItems(id)
      if (task.total === 0 || pending.length === 0 && task.completed === 0) {
        this.change(id, { status: 'resolving', message: '正在解析来源' })
        const works = await this.pixiv.resolveSource(task.source, task.filters, controller.signal)
        for (const work of works) this.db.saveArtwork(work)
        this.db.addItems(id, works.map((w) => w.id))
        pending = works.map((w) => w.id)
        task = this.change(id, { status: 'queued', total: pending.length, message: `已找到 ${pending.length} 个作品` })
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
      const auth = error instanceof PixivError && error.code === 'auth'
      this.change(id, { status: auth ? 'paused' : 'failed', message: error instanceof Error ? error.message : '任务失败' })
    } finally { this.controllers.delete(id) }
  }
  private async worker(taskId: string, queue: string[], signal: AbortSignal): Promise<void> {
    while (queue.length) {
      signal.throwIfAborted()
      const artworkId = queue.shift()
      if (!artworkId) return
      try {
        const task = this.db.getTask(taskId)!
        const artwork = await this.pixiv.getArtwork(artworkId, signal)
        this.db.saveArtwork(artwork)
        await this.downloader.download(artwork, this.settings.get().downloadRoot, task.force, signal, (progress) => {
          this.change(taskId, { status: artwork.type === 'ugoira' && progress.done === progress.total ? 'converting' : 'downloading', message: `${artwork.title}：${progress.message}` })
        })
        this.db.setItem(taskId, artworkId, 'completed')
        const current = this.db.getTask(taskId)!
        this.change(taskId, { completed: current.completed + 1 })
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof PixivError && error.code === 'auth') throw error
        this.db.setItem(taskId, artworkId, 'failed', error instanceof Error ? error.message : '下载失败')
        const current = this.db.getTask(taskId)!
        this.change(taskId, { failed: current.failed + 1, message: `${artworkId} 下载失败` })
      }
    }
  }
  private change(id: string, patch: Parameters<AppDatabase['updateTask']>[1]): TaskRecord { const task = this.db.updateTask(id, patch); this.emit(task); return task }
}
