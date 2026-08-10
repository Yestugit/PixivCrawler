import { describe, expect, it } from 'vitest'
import type { AuthService } from './auth'
import { PixivClient } from './pixiv'
import type { DownloadFilter, ResolveProgress } from '../shared/contracts'

const filters: DownloadFilter = {
  types: ['illust'], includeTags: [], excludeTags: [], bookmarkVisibility: 'both',
  ai: 'include', age: 'all', minBookmarks: 0, minViews: 0, minLikes: 1000
}

function envelope(body: unknown): Response {
  return new Response(JSON.stringify({ error: false, body }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function detail(id: string, likes: number, pageCount = 1): unknown {
  return {
    illustId: id, illustTitle: `work-${id}`, illustComment: '', userId: 'author', userName: 'Author',
    illustType: 0, createDate: '2026-01-01T00:00:00+09:00', pageCount,
    bookmarkCount: 2000, viewCount: 10000, likeCount: likes, tags: { tags: [{ tag: 'theme' }] }
  }
}

describe('optimized Pixiv search resolution', () => {
  it('prefilters summaries, resolves details concurrently, and fetches pages only for matches', async () => {
    const requested: string[] = []
    let active = 0
    let maxActive = 0
    const session = {
      fetch: async (input: string): Promise<Response> => {
        const url = new URL(String(input)); requested.push(`${url.pathname}${url.search}`)
        active += 1; maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        active -= 1
        if (url.pathname === '/rpc/cps.php') return new Response(JSON.stringify({ candidates: [] }), { status: 200 })
        if (url.pathname.startsWith('/ajax/search/artworks/')) return envelope({ illustManga: { total: 3, data: [
          { id: '1', illustType: 2, xRestrict: 0, tags: ['theme'], createDate: '2026-01-01', aiType: 0, pageCount: 1 },
          { id: '2', illustType: 0, xRestrict: 0, tags: ['theme'], createDate: '2026-01-01', aiType: 0, pageCount: 1 },
          { id: '3', illustType: 0, xRestrict: 0, tags: ['theme'], createDate: '2026-01-01', aiType: 0, pageCount: 2 }
        ] } })
        if (url.pathname === '/ajax/illust/2') return envelope(detail('2', 10))
        if (url.pathname === '/ajax/illust/3') return envelope(detail('3', 2000, 2))
        if (url.pathname === '/ajax/illust/3/pages') return envelope([
          { urls: { original: 'https://i.pximg.net/3_p0.jpg' } },
          { urls: { original: 'https://i.pximg.net/3_p1.jpg' } }
        ])
        throw new Error(`Unexpected request: ${url}`)
      }
    }
    const auth = { session } as unknown as AuthService
    const client = new PixivClient(auth, () => 0, () => 4)
    const progress: ResolveProgress[] = []
    const works = await client.resolveSource({ kind: 'search', value: 'theme', maxImages: 2 }, filters, undefined, (value) => progress.push({ ...value }))

    expect(works.map((work) => work.id)).toEqual(['3'])
    expect(requested.some((path) => path.startsWith('/ajax/illust/1?'))).toBe(false)
    expect(requested.some((path) => path.startsWith('/ajax/illust/2/pages'))).toBe(false)
    expect(requested.filter((path) => path.startsWith('/ajax/illust/3/pages'))).toHaveLength(1)
    expect(maxActive).toBeGreaterThan(1)
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(progress.at(-1)).toEqual({ inspectedCandidates: 3, candidateTotal: 3, matchedImages: 2 })
    expect(progress.every((value, index) => index === 0 || value.inspectedCandidates >= progress[index - 1]!.inspectedCandidates)).toBe(true)
  })
  it('applies Retry-After as a global cooldown for concurrent searches', async () => {
    const starts: Array<{ path: string; at: number }> = []
    let rpcCalls = 0
    const session = {
      fetch: async (input: string): Promise<Response> => {
        const url = new URL(String(input)); starts.push({ path: url.pathname, at: Date.now() })
        if (url.pathname === '/rpc/cps.php' && rpcCalls++ === 0) {
          return new Response('{}', { status: 429, headers: { 'retry-after': '0.02' } })
        }
        if (url.pathname === '/rpc/cps.php') return new Response(JSON.stringify({ candidates: [] }), { status: 200 })
        return envelope({ illustManga: { total: 0, data: [] } })
      }
    }
    const client = new PixivClient({ session } as unknown as AuthService, () => 0, () => 4)
    await Promise.all([
      client.resolveSource({ kind: 'search', value: 'one', maxImages: 1 }, { ...filters, minLikes: 0 }),
      client.resolveSource({ kind: 'search', value: 'two', maxImages: 1 }, { ...filters, minLikes: 0 })
    ])
    const first = starts[0]!.at
    const firstSearch = starts.find((item) => item.path.startsWith('/ajax/search/'))!.at
    expect(firstSearch - first).toBeGreaterThanOrEqual(15)
  })
})
