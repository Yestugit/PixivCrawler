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

export function buildUgoiraConcat(frames: { file: string; delay: number }[], frameDir: string): string {
  const escape = (value: string): string => value.replace(/'/g, "'\\''")
  const file = (name: string): string => `file '${escape(path.resolve(frameDir, path.basename(name)))}'`
  const lines = frames.flatMap((frame) => [file(frame.file), `duration ${(frame.delay / 1000).toFixed(6)}`])
  if (frames.length) lines.push(file(frames.at(-1)!.file))
  return lines.join('\n')
}

export class ArtworkDownloader {
  constructor(private readonly session: Session, private readonly db: AppDatabase) {}

  async download(work: PixivArtwork, root: string, force: boolean, signal: AbortSignal, onProgress: (value: DownloadProgress) => void): Promise<string> {
    const authorDir = `${sanitizeSegment(work.userName)}_${work.userId}`
    const workDir = path.join(root, authorDir, `${sanitizeSegment(work.title)}_${work.id}`)
    await fsp.mkdir(workDir, { recursive: true })
    const total = work.pages.length + (work.ugoira ? 2 : 0)
    let done = 0
    for (const page of work.pages) {
      signal.throwIfAborted()
      const extension = this.extension(page.original, '.jpg')
      const target = path.join(workDir, `${work.id}_p${page.index}${extension}`)
      if (!force && fs.existsSync(target)) {
        const stat = await fsp.stat(target)
        if (!this.db.hasFile(work.id, page.index, extension.slice(1), target, stat.size)) await fsp.rm(target, { force: true })
      }
      const result = await this.downloadFile(page.original, target, 'image', force, signal)
      this.db.recordFile(work.id, page.index, extension.slice(1), target, result.size)
      done += 1; onProgress({ done, total, message: `已下载 ${path.basename(target)}` })
    }
    if (work.ugoira) {
      const zipPath = path.join(workDir, `${work.id}_ugoira.zip`)
      if (!force && fs.existsSync(zipPath)) {
        const stat = await fsp.stat(zipPath)
        if (!this.db.hasFile(work.id, -1, 'ugoira-zip', zipPath, stat.size)) await fsp.rm(zipPath, { force: true })
      }
      const zip = await this.downloadFile(work.ugoira.originalSrc, zipPath, 'archive', force, signal)
      this.db.recordFile(work.id, -1, 'ugoira-zip', zipPath, zip.size)
      done += 1; onProgress({ done, total, message: '已下载动图原始帧' })
      const framePath = path.join(workDir, `${work.id}_ugoira.json`)
      await fsp.writeFile(framePath, JSON.stringify(work.ugoira.frames, null, 2), 'utf8')
      const mp4Path = path.join(workDir, `${work.id}_ugoira.mp4`)
      const mp4Stat = !force && fs.existsSync(mp4Path) ? await fsp.stat(mp4Path) : undefined
      if (force || !mp4Stat || !this.db.hasFile(work.id, -1, 'mp4', mp4Path, mp4Stat.size)) await this.convertUgoira(zipPath, work.ugoira.frames, mp4Path, signal)
      const stat = await fsp.stat(mp4Path)
      this.db.recordFile(work.id, -1, 'mp4', mp4Path, stat.size)
      done += 1; onProgress({ done, total, message: '已生成 MP4' })
    }
    const metadataPath = path.join(workDir, 'artwork.json')
    await fsp.writeFile(metadataPath, JSON.stringify({ ...work, downloadedAt: new Date().toISOString(), directory: workDir }, null, 2), 'utf8')
    return workDir
  }

  private async downloadFile(url: string, target: string, expected: 'image' | 'archive', force: boolean, signal: AbortSignal): Promise<{ size: number }> {
    if (!force && fs.existsSync(target)) return { size: (await fsp.stat(target)).size }
    const partial = `${target}.part`
    let offset = !force && fs.existsSync(partial) ? (await fsp.stat(partial)).size : 0
    const headers: Record<string, string> = { Referer: 'https://www.pixiv.net/' }
    if (offset > 0) headers.Range = `bytes=${offset}-`
    const response = await this.session.fetch(url, { headers, signal })
    if (response.status === 403) throw new Error('图片访问被拒绝，登录可能已失效')
    if (!response.ok && response.status !== 206) throw new Error(`文件下载失败（HTTP ${response.status}）`)
    const contentType = response.headers.get('content-type') || ''
    if (expected === 'image' && !contentType.startsWith('image/')) throw new Error(`图片响应类型异常：${contentType || '未知'}`)
    if (offset > 0 && response.status !== 206) { offset = 0; await fsp.rm(partial, { force: true }) }
    if (!response.body) throw new Error('文件响应为空')
    await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' }), { signal })
    const stat = await fsp.stat(partial)
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && stat.size !== offset + contentLength) throw new Error('下载文件长度校验失败')
    await fsp.rename(partial, target)
    return { size: stat.size }
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
