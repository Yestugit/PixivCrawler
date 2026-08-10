import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import * as unzipper from 'unzipper'
import type { Session } from 'electron'
import type { PixivArtwork } from '../shared/contracts'
import { sanitizeSegment } from '../shared/utils'
import type { AppDatabase } from './database'

export interface DownloadProgress { done: number; total: number; message: string }
interface PartialMetadata { taskId: string; url: string; etag?: string; lastModified?: string; total?: number }

export class DownloadError extends Error {
  constructor(
    message: string, readonly retryable: boolean, readonly retryAfterMs?: number,
    readonly code: 'auth' | 'not-found' | 'transient' | 'permanent' = retryable ? 'transient' : 'permanent'
  ) { super(message) }
}

export function buildUgoiraConcat(frames: { file: string; delay: number }[], frameDir: string): string {
  const escape = (value: string): string => value.replace(/'/g, "'\\''")
  const file = (name: string): string => `file '${escape(path.resolve(frameDir, path.basename(name)))}'`
  const lines = frames.flatMap((frame) => [file(frame.file), `duration ${(frame.delay / 1000).toFixed(6)}`])
  if (frames.length) lines.push(file(frames.at(-1)!.file))
  return lines.join('\n')
}

export class ArtworkDownloader {
  constructor(private readonly session: Session, private readonly db: AppDatabase) {}

  async download(taskId: string, work: PixivArtwork, root: string, force: boolean, signal: AbortSignal, onProgress: (value: DownloadProgress) => void): Promise<string> {
    const authorDir = `${sanitizeSegment(work.userName)}_${work.userId}`
    const workDir = path.join(root, authorDir, `${sanitizeSegment(work.title)}_${work.id}`)
    await fsp.mkdir(workDir, { recursive: true })
    const total = work.pages.length + (work.ugoira ? 2 : 0)
    let done = 0
    for (const page of work.pages) {
      signal.throwIfAborted()
      const extension = this.extension(page.original, '.jpg')
      const target = path.join(workDir, `${work.id}_p${page.index}${extension}`)
      const format = extension.slice(1)
      const existing = fs.existsSync(target) ? await fsp.stat(target) : undefined
      const reusable = existing && (this.db.hasTaskFile(taskId, work.id, page.index, format, target, existing.size) ||
        (!force && this.db.hasFile(work.id, page.index, format, target, existing.size)))
      const result = reusable ? { size: existing.size } : await this.downloadFile(taskId, page.original, target, 'image', force, signal)
      this.db.recordFile(work.id, page.index, extension.slice(1), target, result.size)
      this.db.recordTaskFile(taskId, work.id, page.index, format, target, result.size)
      done += 1; onProgress({ done, total, message: `已下载 ${path.basename(target)}` })
    }
    if (work.ugoira) {
      const zipPath = path.join(workDir, `${work.id}_ugoira.zip`)
      const zipStat = fs.existsSync(zipPath) ? await fsp.stat(zipPath) : undefined
      const zipReusable = zipStat && (this.db.hasTaskFile(taskId, work.id, -1, 'ugoira-zip', zipPath, zipStat.size) ||
        (!force && this.db.hasFile(work.id, -1, 'ugoira-zip', zipPath, zipStat.size)))
      const zip = zipReusable ? { size: zipStat.size } : await this.downloadFile(taskId, work.ugoira.originalSrc, zipPath, 'archive', force, signal)
      this.db.recordFile(work.id, -1, 'ugoira-zip', zipPath, zip.size)
      this.db.recordTaskFile(taskId, work.id, -1, 'ugoira-zip', zipPath, zip.size)
      done += 1; onProgress({ done, total, message: '已下载动图原始帧' })
      const framePath = path.join(workDir, `${work.id}_ugoira.json`)
      await fsp.writeFile(framePath, JSON.stringify(work.ugoira.frames, null, 2), 'utf8')
      const mp4Path = path.join(workDir, `${work.id}_ugoira.mp4`)
      const mp4Stat = fs.existsSync(mp4Path) ? await fsp.stat(mp4Path) : undefined
      const mp4Reusable = mp4Stat && (this.db.hasTaskFile(taskId, work.id, -1, 'mp4', mp4Path, mp4Stat.size) ||
        (!force && this.db.hasFile(work.id, -1, 'mp4', mp4Path, mp4Stat.size)))
      if (!mp4Reusable) {
        await fsp.rm(mp4Path, { force: true })
        await this.convertUgoira(zipPath, work.ugoira.frames, mp4Path, signal)
      }
      const stat = await fsp.stat(mp4Path)
      this.db.recordFile(work.id, -1, 'mp4', mp4Path, stat.size)
      this.db.recordTaskFile(taskId, work.id, -1, 'mp4', mp4Path, stat.size)
      done += 1; onProgress({ done, total, message: '已生成 MP4' })
    }
    const metadataPath = path.join(workDir, 'artwork.json')
    await fsp.writeFile(metadataPath, JSON.stringify({ ...work, downloadedAt: new Date().toISOString(), directory: workDir }, null, 2), 'utf8')
    return workDir
  }

  private async downloadFile(taskId: string, url: string, target: string, expected: 'image' | 'archive', force: boolean, signal: AbortSignal): Promise<{ size: number }> {
    const partial = `${target}.part`
    const metadataPath = `${partial}.json`
    let metadata = await this.readPartialMetadata(metadataPath)
    if (force && metadata?.taskId !== taskId) {
      await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(metadataPath, { force: true })])
      metadata = undefined
    }
    await fsp.rm(target, { force: true })
    let offset = fs.existsSync(partial) ? (await fsp.stat(partial)).size : 0
    if (metadata && metadata.url !== url) {
      await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(metadataPath, { force: true })])
      metadata = undefined; offset = 0
    }
    const headers: Record<string, string> = { Referer: 'https://www.pixiv.net/' }
    if (offset > 0) {
      headers.Range = `bytes=${offset}-`
      const validator = metadata?.etag || metadata?.lastModified
      if (validator) headers['If-Range'] = validator
    }
    let response: Response
    try { response = await this.session.fetch(url, { headers, signal }) }
    catch (error) {
      if (signal.aborted) throw error
      const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
      throw new DownloadError(error instanceof Error ? error.message : '图片网络连接中断', !['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(code))
    }
    if (response.status === 401 || response.status === 403) throw new DownloadError('图片访问被拒绝，登录可能已失效', false, undefined, 'auth')
    if (response.status === 404) throw new DownloadError('图片资源不存在或已被删除', false, undefined, 'not-found')
    if (response.status === 416 && offset > 0) {
      await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(metadataPath, { force: true })])
      return this.downloadFile(taskId, url, target, expected, force, signal)
    }
    if (response.status === 429) throw new DownloadError('图片服务器请求过于频繁', true, this.retryAfter(response.headers.get('retry-after')))
    if (response.status === 408 || response.status === 425 || response.status >= 500) throw new DownloadError(`图片服务器暂时不可用（HTTP ${response.status}）`, true)
    if (!response.ok && response.status !== 206) throw new DownloadError(`文件下载失败（HTTP ${response.status}）`, false)
    const contentType = response.headers.get('content-type') || ''
    if (expected === 'image' && !contentType.startsWith('image/')) throw new DownloadError(`图片响应类型异常：${contentType || '未知'}`, true)
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i)
    if (offset > 0 && response.status === 206 && (!range || Number(range[1]) !== offset)) {
      await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(metadataPath, { force: true })])
      return this.downloadFile(taskId, url, target, expected, force, signal)
    }
    if (offset > 0 && response.status !== 206) { offset = 0; await fsp.rm(partial, { force: true }) }
    if (!response.body) throw new DownloadError('文件响应为空', true)
    const contentLengthHeader = response.headers.get('content-length')
    const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
    const total = range?.[3] && range[3] !== '*' ? Number(range[3]) : contentLength !== undefined && Number.isFinite(contentLength) ? offset + contentLength : undefined
    metadata = {
      taskId, url, etag: response.headers.get('etag') || undefined,
      lastModified: response.headers.get('last-modified') || undefined, total
    }
    await fsp.writeFile(metadataPath, JSON.stringify(metadata), 'utf8')
    try {
      await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' }), { signal })
    } catch (error) {
      if (signal.aborted) throw error
      const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? '') : ''
      throw new DownloadError(error instanceof Error ? error.message : '文件传输中断', !['ENOSPC', 'EACCES', 'EPERM', 'EROFS'].includes(code))
    }
    const stat = await fsp.stat(partial)
    if (contentLength !== undefined && Number.isFinite(contentLength) && stat.size !== offset + contentLength) throw new DownloadError('下载文件长度校验失败', true)
    if (metadata.total !== undefined && stat.size !== metadata.total) throw new DownloadError('下载文件总长度校验失败', true)
    await fsp.rename(partial, target)
    await fsp.rm(metadataPath, { force: true })
    return { size: stat.size }
  }

  private async readPartialMetadata(file: string): Promise<PartialMetadata | undefined> {
    try {
      const value = JSON.parse(await fsp.readFile(file, 'utf8')) as PartialMetadata
      return value && typeof value.taskId === 'string' && typeof value.url === 'string' ? value : undefined
    } catch { return undefined }
  }
  private retryAfter(value: string | null): number | undefined {
    if (!value) return undefined
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(value)
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
  }

  private async convertUgoira(zipPath: string, frames: { file: string; delay: number }[], output: string, signal: AbortSignal): Promise<void> {
    const { app } = await import('electron')
    const ffmpeg = app.isPackaged
      ? path.join(process.resourcesPath, 'ffmpeg', 'bin', 'ffmpeg.exe')
      : path.join(app.getAppPath(), 'resources', 'ffmpeg', 'bin', 'ffmpeg.exe')
    if (!fs.existsSync(ffmpeg)) throw new Error('未找到 LGPL FFmpeg，请运行 npm run fetch:ffmpeg')
    const frameDir = `${output}.frames`
    await fsp.rm(frameDir, { recursive: true, force: true })
    await fsp.mkdir(frameDir, { recursive: true })
    try {
      const archive = await unzipper.Open.file(zipPath)
      const expected = new Set(frames.map((frame) => frame.file))
      const entries = new Map(archive.files.filter((entry) => entry.type === 'File' && expected.has(entry.path)).map((entry) => [entry.path, entry]))
      if (entries.size !== expected.size) throw new Error('ugoira 压缩包缺少帧文件')
      for (const frame of frames) {
        const entry = entries.get(frame.file)!
        if (entry.uncompressedSize > 100 * 1024 * 1024) throw new Error('ugoira 单帧超过安全大小限制')
        const target = path.resolve(frameDir, path.basename(frame.file))
        await pipeline(entry.stream(), fs.createWriteStream(target), { signal })
      }
      const concatPath = path.join(frameDir, 'frames.txt')
      await fsp.writeFile(concatPath, buildUgoiraConcat(frames, frameDir), 'utf8')
      try {
        await this.runFfmpeg(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-an', '-c:v', 'h264_mf', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], signal)
      } catch {
        signal.throwIfAborted()
        await this.runFfmpeg(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-an', '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], signal)
      }
    } finally { await fsp.rm(frameDir, { recursive: true, force: true }) }
  }
  private runFfmpeg(executable: string, args: string[], signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true, signal })
      let error = ''
      child.stderr.on('data', (chunk) => { error = `${error}${String(chunk)}`.slice(-4000) })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 转换失败（${code}）：${error}`)))
    })
  }
  private extension(url: string, fallback: string): string {
    try { const ext = path.extname(new URL(url).pathname).toLowerCase(); return /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : fallback } catch { return fallback }
  }
}
