import { describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { DownloadError } from './downloader'
import type { PixivArtwork } from '../shared/contracts'
import type { PixivClient } from './pixiv'
import type { ArtworkDownloader } from './downloader'
import type { SettingsStore } from './settings'
import { TaskManager } from './task-manager'

const artwork: PixivArtwork = {
  id: '42', title: 'retry', description: '', userId: '7', userName: 'author', type: 'illust', tags: [],
  createDate: '2026-01-01', uploadDate: '2026-01-01', aiType: 0, xRestrict: 0,
  bookmarkCount: 0, viewCount: 0, likeCount: 0, sourceUrl: 'https://www.pixiv.net/artworks/42',
  pages: [{ index: 0, original: 'https://i.pximg.net/42.jpg' }]
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('TaskManager download retries', () => {
  it('automatically retries a transient artwork failure three times before succeeding', async () => {
    const db = new AppDatabase(':memory:')
    let attempts = 0
    const pixiv = {
      resolveSource: async (_source: unknown, _filters: unknown, _signal: unknown, onProgress: ((value: unknown) => void) | undefined, hooks: { onAccepted?(value: PixivArtwork): void }) => {
        hooks.onAccepted?.(artwork)
        onProgress?.({ inspectedCandidates: 1, candidateTotal: 1, matchedImages: 1 })
        return [artwork]
      },
      getArtwork: async () => artwork
    } as unknown as PixivClient
    const downloader = {
      download: async () => {
        attempts += 1
        if (attempts <= 3) throw new DownloadError('temporary', true, 0)
      }
    } as unknown as ArtworkDownloader
    const settings = { get: () => ({ concurrency: 1, downloadRoot: 'unused' }) } as unknown as SettingsStore
    const manager = new TaskManager(db, pixiv, downloader, settings, () => undefined)
    const task = manager.create({
      source: { kind: 'artworks', values: ['42'] },
      filters: { types: ['illust'], includeTags: [], excludeTags: [], bookmarkVisibility: 'both', ai: 'include', age: 'all', minBookmarks: 0, minViews: 0, minLikes: 0 },
      force: false
    })
    await until(() => db.getTask(task.id)?.status === 'completed')
    expect(attempts).toBe(4)
    expect(db.getTask(task.id)).toMatchObject({ completed: 1, failed: 0, status: 'completed' })
    db.close()
  })

  it('waits for a paused run to stop and resumes from its saved resolver index', async () => {
    const db = new AppDatabase(':memory:')
    const starts: number[] = []
    const pixiv = {
      resolveSource: async (_source: unknown, _filters: unknown, signal: AbortSignal, onProgress: (value: { inspectedCandidates: number; candidateTotal: number; matchedImages: number }) => void, hooks: {
        checkpoint?: unknown
        onCheckpoint(value: unknown): void
        onAccepted(value: PixivArtwork): void
      }) => {
        const ids = ['1', '2', '3']
        let next = Number((hooks.checkpoint as { nextIndex?: number } | undefined)?.nextIndex ?? 0)
        starts.push(next)
        while (next < ids.length) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          signal.throwIfAborted()
          next += 1
          hooks.onCheckpoint({ version: 1, kind: 'ids', ids, nextIndex: next, matchedImages: 0, candidateTotal: ids.length })
          onProgress({ inspectedCandidates: next, candidateTotal: ids.length, matchedImages: 0 })
        }
        hooks.onAccepted(artwork)
        return [artwork]
      },
      getArtwork: async () => artwork
    } as unknown as PixivClient
    const downloader = { download: async () => undefined } as unknown as ArtworkDownloader
    const settings = { get: () => ({ concurrency: 1, downloadRoot: 'unused' }) } as unknown as SettingsStore
    const manager = new TaskManager(db, pixiv, downloader, settings, () => undefined)
    const task = manager.create({
      source: { kind: 'artworks', values: ['42'] },
      filters: { types: ['illust'], includeTags: [], excludeTags: [], bookmarkVisibility: 'both', ai: 'include', age: 'all', minBookmarks: 0, minViews: 0, minLikes: 0 },
      force: false
    })
    await until(() => db.getTask(task.id)!.inspectedCandidates >= 1)
    const pausedAt = db.getTask(task.id)!.inspectedCandidates
    await manager.pause(task.id)
    expect(db.getTask(task.id)).toMatchObject({ status: 'paused', inspectedCandidates: pausedAt })
    manager.resume(task.id)
    await until(() => db.getTask(task.id)?.status === 'completed')
    expect(starts).toHaveLength(2)
    expect(starts[1]).toBeGreaterThanOrEqual(pausedAt)
    db.close()
  })
})
