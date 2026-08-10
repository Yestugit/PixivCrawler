import { describe, expect, it } from 'vitest'
import { jitter, parseArtworkId, parseUserId, retryDelay, sanitizeSegment } from './utils'

describe('shared utilities', () => {
  it('parses only Pixiv artwork and user identifiers', () => {
    expect(parseArtworkId('https://www.pixiv.net/artworks/123')).toBe('123')
    expect(parseArtworkId('123')).toBe('123')
    expect(parseArtworkId('https://evil.test/artworks/123')).toBeNull()
    expect(parseUserId('https://www.pixiv.net/users/42')).toBe('42')
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
  })
})
