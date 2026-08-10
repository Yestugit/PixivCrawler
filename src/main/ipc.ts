import path from 'node:path'
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { CreateTaskSchema, SettingsSchema, type TaskRecord } from '../shared/contracts'
import { channels } from '../shared/ipc-contract'
import type { AuthService } from './auth'
import type { PixivClient } from './pixiv'
import type { SettingsStore } from './settings'
import type { TaskManager } from './task-manager'

export function registerIpc(window: BrowserWindow, deps: { auth: AuthService; pixiv: PixivClient; settings: SettingsStore; tasks: TaskManager }): void {
  const sender = (event: Electron.IpcMainInvokeEvent): void => { if (event.sender.id !== window.webContents.id) throw new Error('拒绝未知窗口的 IPC 请求') }
  const handle = <T extends unknown[]>(channel: string, fn: (...args: T) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => { sender(event); return fn(...args as T) })
  }
  handle(channels.authStatus, () => deps.auth.getStatus())
  handle(channels.authOpen, () => deps.auth.openLogin())
  handle(channels.authLogout, () => deps.auth.logout())
  handle(channels.sourcePreview, (input: unknown) => deps.tasks.preview(CreateTaskSchema.parse(input)))
  handle(channels.taskCreate, (input: unknown) => deps.tasks.create(CreateTaskSchema.parse(input)))
  handle(channels.taskList, () => deps.tasks.list())
  const id = z.string().min(1)
  handle(channels.taskPause, (value: unknown) => deps.tasks.pause(id.parse(value)))
  handle(channels.taskResume, (value: unknown) => deps.tasks.resume(id.parse(value)))
  handle(channels.taskCancel, (value: unknown) => deps.tasks.cancel(id.parse(value)))
  handle(channels.taskRetry, (value: unknown) => deps.tasks.retry(id.parse(value)))
  handle(channels.settingsGet, () => deps.settings.get())
  handle(channels.settingsUpdate, async (value: unknown) => {
    const settings = deps.settings.set(SettingsSchema.parse(value))
    await deps.pixiv.configureProxy(settings.proxyMode, settings.proxyUrl)
    return settings
  })
  handle(channels.settingsTestProxy, async (value: unknown) => {
    const settings = SettingsSchema.parse(value)
    try {
      await deps.pixiv.configureProxy(settings.proxyMode, settings.proxyUrl)
      const latencyMs = await deps.pixiv.testConnection()
      return { ok: true, latencyMs, message: `连接成功，${latencyMs} ms` }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '连接失败' } }
  })
  handle(channels.appCheckUpdates, async () => {
    const settings = deps.settings.get()
    const current = app.getVersion()
    if (!settings.githubRepo) return { available: false, current, error: '尚未配置 GitHub 仓库' }
    try {
      const response = await fetch(`https://api.github.com/repos/${settings.githubRepo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PixivCrawler' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const release = await response.json() as { tag_name: string; html_url: string }
      const latest = release.tag_name.replace(/^v/, '')
      return { available: latest !== current, current, latest, url: release.html_url }
    } catch (error) { return { available: false, current, error: error instanceof Error ? error.message : '检查更新失败' } }
  })
  handle(channels.appOpenPath, async (value: unknown) => {
    const target = z.string().min(1).parse(value)
    if (/^https:\/\//i.test(target)) {
      const url = new URL(target)
      if (url.hostname !== 'github.com') throw new Error('只允许打开 GitHub 更新链接')
      await shell.openExternal(target); return
    }
    const root = path.resolve(deps.settings.get().downloadRoot)
    const resolved = path.resolve(target)
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('只能打开下载目录内的路径')
    const error = await shell.openPath(resolved)
    if (error) throw new Error(error)
  })
}

export function sendTaskProgress(window: BrowserWindow, task: TaskRecord): void {
  if (!window.isDestroyed()) window.webContents.send(channels.taskProgress, task)
}
