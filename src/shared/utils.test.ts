import { describe, expect, it } from 'vitest'
import { jitter, parseArtworkId, parseSearchKeyword, parseUserId, retryDelay, sanitizeSegment, upperJitter, upsertTask } from './utils'
import type { TaskRecord } from './contracts'

describe('shared utilities', () => {
  it('parses only Pixiv artwork and user identifiers', () => {
    expect(parseArtworkId('https://www.pixiv.net/artworks/123')).toBe('123')
    expect(parseArtworkId('123')).toBe('123')
    expect(parseArtworkId('https://evil.test/artworks/123')).toBeNull()
    expect(parseUserId('https://www.pixiv.net/users/42')).toBe('42')
  })
  it('accepts search keywords and Pixiv tag links', () => {
    expect(parseSearchKeyword('莉可丽丝')).toBe('莉可丽丝')
    expect(parseSearchKeyword('https://www.pixiv.net/tags/%E3%83%AA%E3%82%B3%E3%83%AA%E3%82%B9%E3%83%BB%E3%83%AA%E3%82%B3%E3%82%A4%E3%83%AB')).toBe('リコリス・リコイル')
    expect(parseSearchKeyword('https://evil.test/tags/cat')).toBeNull()
  })
  it('creates Windows-safe path segments', () => {
    expect(sanitizeSegment('a:b?c. ')).toBe('a_b_c')
    expect(sanitizeSegment('CON')).toBe('_CON')
  })
  it('backs off predictably', () => {
    expect(retryDelay(2)).toBe(4000)
    expect(retryDelay(0, 429)).toBe(60000)
    expect(retryDelay(0, 429, '3')).toBe(3000)
    expect(jitter(2000, () => 0)).toBe(1500)
    expect(upperJitter(500, () => 0)).toBe(500)
    expect(upperJitter(500, () => 1)).toBe(625)
  })
  it('upserts task progress without duplicating a task card', () => {
    const base = { id: 'task', createdAt: '2026-01-01T00:00:00Z' } as TaskRecord
    const progress = { ...base, message: 'progress' }
    expect(upsertTask(upsertTask([], base), progress)).toEqual([progress])
  })
})
