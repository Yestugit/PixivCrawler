import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { buildUgoiraConcat } from './downloader'
import { matchesArtwork } from './pixiv'
import type { CreateTaskInput, PixivArtwork } from '../shared/contracts'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  source: { kind: 'artworks', values: ['1'] }, force: false,
  filters: { types: ['illust', 'manga', 'ugoira'], includeTags: [], excludeTags: [], bookmarkVisibility: 'both', ai: 'include', age: 'all' }
}
const artwork: PixivArtwork = {
  id: '1', title: 'work', description: '', userId: '2', userName: 'author', type: 'illust', tags: ['cat', 'Blue'],
  createDate: '2026-01-02T00:00:00+09:00', uploadDate: '2026-01-02T00:00:00+09:00', aiType: 0, xRestrict: 0,
  sourceUrl: 'https://www.pixiv.net/artworks/1', pages: []
}

describe('core persistence and filtering', () => {
  it('migrates the database and pauses interrupted work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-crawler-')); temporary.push(dir)
    const file = path.join(dir, 'test.sqlite3')
    const first = new AppDatabase(file)
    first.createTask('task', input)
    first.updateTask('task', { status: 'downloading' })
    first.close()
    const reopened = new AppDatabase(file)
    expect(reopened.getTask('task')?.status).toBe('paused')
    reopened.close()
  })
  it('applies type, date, tag, AI and age filters', () => {
    expect(matchesArtwork(artwork, { ...input.filters, includeTags: ['blue'] })).toBe(true)
    expect(matchesArtwork(artwork, { ...input.filters, excludeTags: ['cat'] })).toBe(false)
    expect(matchesArtwork({ ...artwork, aiType: 2 }, { ...input.filters, ai: 'exclude' })).toBe(false)
    expect(matchesArtwork({ ...artwork, xRestrict: 1 }, { ...input.filters, age: 'safe' })).toBe(false)
    expect(matchesArtwork(artwork, { ...input.filters, dateFrom: '2026-02-01' })).toBe(false)
  })
  it('preserves ugoira frame timing and repeats the last frame', () => {
    const text = buildUgoiraConcat([{ file: '000.jpg', delay: 80 }, { file: '001.jpg', delay: 120 }], 'C:\\frames')
    expect(text).toContain('duration 0.080000')
    expect(text).toContain('duration 0.120000')
    expect(text.match(/001\.jpg/g)).toHaveLength(2)
  })
})
