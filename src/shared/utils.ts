import type { TaskRecord } from './contracts'

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function upsertTask(tasks: TaskRecord[], task: TaskRecord): TaskRecord[] {
  return [task, ...tasks.filter((item) => item.id !== task.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function uniqueTasks(tasks: TaskRecord[]): TaskRecord[] { return tasks.reduce(upsertTask, [] as TaskRecord[]) }

export function sanitizeSegment(value: string, fallback = 'untitled', max = 80): string {
  let result = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
  if (!result) result = fallback
  if (RESERVED.test(result)) result = `_${result}`
  return result.slice(0, max).replace(/[. ]+$/g, '') || fallback
}

export function parseArtworkId(value: string): string | null {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (!/(^|\.)pixiv\.net$/i.test(url.hostname)) return null
    return url.pathname.match(/\/artworks\/(\d+)/)?.[1] ?? null
  } catch { return null }
}

export function parseUserId(value: string): string | null {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed)
    if (!/(^|\.)pixiv\.net$/i.test(url.hostname)) return null
    return url.pathname.match(/\/users\/(\d+)/)?.[1] ?? null
  } catch { return null }
}

export function parseSearchKeyword(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (!/(^|\.)pixiv\.net$/i.test(url.hostname)) return null
    const tag = url.pathname.match(/\/tags\/([^/]+)/)?.[1]
    if (tag) return decodeURIComponent(tag).trim() || null
    return url.searchParams.get('word')?.trim() || null
  } catch { return trimmed }
}

export function retryDelay(attempt: number, status?: number, retryAfter?: string | null): number {
  if (status === 429) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 900_000)
    return Math.min(60_000 * 2 ** attempt, 900_000)
  }
  return Math.min(1000 * 2 ** attempt, 16_000)
}

export function jitter(ms: number, random = Math.random): number { return Math.round(ms * (0.75 + random() * 0.5)) }
export function upperJitter(ms: number, random = Math.random): number { return Math.round(ms * (1 + random() * 0.25)) }

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
