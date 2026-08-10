import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as unzipper from 'unzipper'

const archiveName = 'ffmpeg-n8.1.2-34-g9b6c8969e0-win64-lgpl-shared-8.1.zip'
const releaseTag = 'autobuild-2026-08-09-13-03'
const expectedSha256 = '2936e5449886641b4279ca3fc554b678c8e9a2d20dd0c0a34fe7208b254a0905'
const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${releaseTag}/${archiveName}`
const root = path.resolve('resources', 'ffmpeg')
const archivePath = path.join(root, archiveName)
const binDir = path.join(root, 'bin')
const requiredFiles = ['ffmpeg.exe', 'avcodec-62.dll', 'avdevice-62.dll', 'avfilter-11.dll', 'avformat-62.dll', 'avutil-60.dll', 'swresample-6.dll', 'swscale-9.dll']

await fsp.mkdir(root, { recursive: true })
const metadataPath = path.join(root, 'build.json')
if (requiredFiles.every((name) => fs.existsSync(path.join(binDir, name))) && fs.existsSync(metadataPath)) {
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'))
  if (metadata.sha256 === expectedSha256 && metadata.archiveName === archiveName) {
    console.log('Pinned LGPL FFmpeg is already verified.')
    process.exit(0)
  }
}
if (!fs.existsSync(archivePath) || await sha256(archivePath) !== expectedSha256) {
  await downloadWithResume(url, archivePath)
}
const actual = await sha256(archivePath)
if (actual !== expectedSha256) throw new Error(`FFmpeg SHA-256 mismatch: ${actual}`)

await fsp.rm(binDir, { recursive: true, force: true })
await fsp.mkdir(binDir, { recursive: true })
const archive = await unzipper.Open.file(archivePath)
let extracted = 0
for (const entry of archive.files) {
  if (entry.type !== 'File') continue
  const normalized = entry.path.replaceAll('\\', '/')
  const binMarker = '/bin/'
  if (normalized.includes(binMarker)) {
    const name = path.basename(normalized)
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`Unsafe FFmpeg entry: ${name}`)
    if (name !== 'ffmpeg.exe' && !name.toLowerCase().endsWith('.dll')) continue
    await pipeline(entry.stream(), fs.createWriteStream(path.join(binDir, name)))
    extracted += 1
  } else if (/\/(LICENSE|README)\.txt$/i.test(normalized)) {
    await pipeline(entry.stream(), fs.createWriteStream(path.join(root, path.basename(normalized))))
  }
}
if (!fs.existsSync(path.join(binDir, 'ffmpeg.exe')) || extracted < 2) throw new Error('FFmpeg archive did not contain the expected shared build')
await fsp.writeFile(metadataPath, JSON.stringify({ releaseTag, archiveName, sha256: expectedSha256, source: url, fetchedAt: new Date().toISOString() }, null, 2))
await fsp.rm(archivePath, { force: true })
console.log(`Verified and extracted ${extracted} FFmpeg files.`)

async function sha256(file) {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

async function downloadWithResume(source, target) {
  const partial = `${target}.part`
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      let offset = fs.existsSync(partial) ? (await fsp.stat(partial)).size : 0
      const headers = { 'User-Agent': 'PixivCrawler-FFmpeg-Fetcher' }
      if (offset) headers.Range = `bytes=${offset}-`
      const response = await fetch(source, { redirect: 'follow', headers })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      if (offset && response.status !== 206) { await fsp.rm(partial, { force: true }); offset = 0 }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(partial, { flags: offset ? 'a' : 'w' }))
      const expectedTail = Number(response.headers.get('content-length'))
      const size = (await fsp.stat(partial)).size
      if (Number.isFinite(expectedTail) && size !== offset + expectedTail) throw new Error(`truncated response: ${size}/${offset + expectedTail}`)
      await fsp.rename(partial, target)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 15000)))
    }
  }
  throw new Error(`FFmpeg download failed after retries: ${lastError}`)
}
