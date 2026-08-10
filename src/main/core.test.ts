import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './database'
import { buildUgoiraConcat } from './downloader'
import { matchesArtwork, pickTranslatedTag } from './pixiv'
import type { CreateTaskInput, PixivArtwork } from '../shared/contracts'
import { SourceSchema } from '../shared/contracts'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

const input: CreateTaskInput = {
  source: { kind: 'artworks', values: ['1'] }, force: false,
  filters: { types: ['illust', 'manga', 'ugoira'], includeTags: [], excludeTags: [], bookmarkVisibility: 'both', ai: 'include', age: 'all', minBookmarks: 0, minViews: 0, minLikes: 0 }
}
const artwork: PixivArtwork = {
  id: '1', title: 'work', description: '', userId: '2', userName: 'author', type: 'illust', tags: ['cat', 'Blue'],
  createDate: '2026-01-02T00:00:00+09:00', uploadDate: '2026-01-02T00:00:00+09:00', aiType: 0, xRestrict: 0,
  bookmarkCount: 120, viewCount: 3000, likeCount: 80, sourceUrl: 'https://www.pixiv.net/artworks/1', pages: []
}

describe('core persistence and filtering', () => {
  it('validates keyword search sources and result limits', () => {
    expect(SourceSchema.parse({ kind: 'search', value: '风景' })).toMatchObject({ maxImages: 100, strategy: 'newest' })
    expect(() => SourceSchema.parse({ kind: 'search', value: '', maxImages: 100 })).toThrow()
    expect(() => SourceSchema.parse({ kind: 'search', value: '风景', maxImages: 101 })).toThrow()
  })
  it('resolves an exact translated Pixiv tag without guessing unrelated candidates', () => {
    const candidates = [{ tag_name: 'リコリス・リコイル', tag_translation: '莉可丽丝' }]
    expect(pickTranslatedTag('莉可丽丝', candidates)).toBe('リコリス・リコイル')
    expect(pickTranslatedTag('莉可', candidates)).toBe('莉可')
  })
  it('migrates the database and pauses interrupted work', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-crawler-')); temporary.push(dir)
    const file = path.join(dir, 'test.sqlite3')
    const first = new AppDatabase(file)
    first.createTask('task', input)
    expect(first.getTask('task')).toMatchObject({ inspectedCandidates: 0, candidateTotal: 0, matchedImages: 0 })
    first.updateTask('task', { status: 'downloading' })
    first.close()
    const reopened = new AppDatabase(file)
    expect(reopened.getTask('task')?.status).toBe('paused')
    reopened.close()
  })
  it('adds resolving progress columns to a version 1 database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-crawler-v1-')); temporary.push(dir)
    const file = path.join(dir, 'test.sqlite3')
    const legacy = new DatabaseSync(file)
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations(version) VALUES (1);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, source_json TEXT NOT NULL, filters_json TEXT NOT NULL,
        status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', force INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `)
    legacy.close()
    const migrated = new AppDatabase(file)
    expect(migrated.createTask('task', input)).toMatchObject({ inspectedCandidates: 0, candidateTotal: 0, matchedImages: 0 })
    migrated.close()
  })
  it('applies type, date, tag, AI and age filters', () => {
    expect(matchesArtwork(artwork, { ...input.filters, includeTags: ['blue'] })).toBe(true)
    expect(matchesArtwork(artwork, { ...input.filters, excludeTags: ['cat'] })).toBe(false)
    expect(matchesArtwork({ ...artwork, aiType: 2 }, { ...input.filters, ai: 'exclude' })).toBe(false)
    expect(matchesArtwork({ ...artwork, xRestrict: 1 }, { ...input.filters, age: 'safe' })).toBe(false)
    expect(matchesArtwork(artwork, { ...input.filters, dateFrom: '2026-02-01' })).toBe(false)
    expect(matchesArtwork(artwork, { ...input.filters, minBookmarks: 121 })).toBe(false)
    expect(matchesArtwork(artwork, { ...input.filters, minViews: 3000, minLikes: 80 })).toBe(true)
  })
  it('preserves ugoira frame timing and repeats the last frame', () => {
    const text = buildUgoiraConcat([{ file: '000.jpg', delay: 80 }, { file: '001.jpg', delay: 120 }], 'C:\\frames')
    expect(text).toContain('duration 0.080000')
    expect(text).toContain('duration 0.120000')
    expect(text.match(/001\.jpg/g)).toHaveLength(2)
  })
})
