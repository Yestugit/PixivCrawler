import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import type { PixivArtwork } from '../shared/contracts'
import { AppDatabase } from './database'
import { ArtworkDownloader } from './downloader'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe('ArtworkDownloader partial files', () => {
  it('continues a forced task from its validated partial byte range', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pixiv-crawler-download-'))
    roots.push(root)
    const ranges: Array<string | undefined> = []
    let call = 0
    const session = {
      fetch: async (_url: string, init?: RequestInit): Promise<Response> => {
        ranges.push(new Headers(init?.headers).get('range') ?? undefined)
        call += 1
        if (call === 1) {
          return new Response('abc', { headers: { 'content-type': 'image/jpeg', 'content-length': '6', etag: 'same' } })
        }
        return new Response('def', { status: 206, headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 3-5/6', 'content-length': '3', etag: 'same' } })
      }
    } as unknown as Session
    const db = new AppDatabase(':memory:')
    const downloader = new ArtworkDownloader(session, db)
    const work: PixivArtwork = {
      id: '9', title: 'partial', description: '', userId: '8', userName: 'author', type: 'illust', tags: [],
      createDate: '2026-01-01', uploadDate: '2026-01-01', aiType: 0, xRestrict: 0,
      bookmarkCount: 0, viewCount: 0, likeCount: 0, sourceUrl: 'https://www.pixiv.net/artworks/9',
      pages: [{ index: 0, original: 'https://i.pximg.net/9.jpg' }]
    }
    await expect(downloader.download('task', work, root, true, new AbortController().signal, () => undefined)).rejects.toThrow()
    await downloader.download('task', work, root, true, new AbortController().signal, () => undefined)
    expect(ranges).toEqual([undefined, 'bytes=3-'])
    const target = path.join(root, 'author_8', 'partial_9', '9_p0.jpg')
    expect(await fs.readFile(target, 'utf8')).toBe('abcdef')
    db.close()
  })
})
