import { z } from 'zod'

export const TaskStatusSchema = z.enum([
  'resolving', 'queued', 'downloading', 'converting', 'paused',
  'completed', 'partial', 'failed', 'canceled'
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const SourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artworks'), values: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('search'), value: z.string().trim().min(1).max(500), maxImages: z.number().int().min(1).max(100).default(100) }),
  z.object({ kind: z.literal('author'), value: z.string().min(1) }),
  z.object({ kind: z.literal('bookmarks') })
])
export type DownloadSource = z.infer<typeof SourceSchema>

export const FilterSchema = z.object({
  types: z.array(z.enum(['illust', 'manga', 'ugoira'])).default(['illust', 'manga', 'ugoira']),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  includeTags: z.array(z.string()).default([]),
  excludeTags: z.array(z.string()).default([]),
  bookmarkVisibility: z.enum(['show', 'hide', 'both']).default('both'),
  ai: z.enum(['include', 'exclude', 'only']).default('include'),
  age: z.enum(['all', 'safe', 'r18']).default('all'),
  minBookmarks: z.number().int().min(0).default(0),
  minViews: z.number().int().min(0).default(0),
  minLikes: z.number().int().min(0).default(0)
})
export type DownloadFilter = z.infer<typeof FilterSchema>

export const CreateTaskSchema = z.object({
  source: SourceSchema,
  filters: FilterSchema,
  force: z.boolean().default(false)
})
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>

export const SettingsSchema = z.object({
  downloadRoot: z.string().min(1),
  concurrency: z.number().int().min(1).max(4),
  requestIntervalMs: z.number().int().min(1000).max(10000),
  proxyMode: z.enum(['system', 'custom']),
  proxyUrl: z.string(),
  acceptedNotice: z.boolean(),
  githubRepo: z.string()
}).superRefine((value, context) => {
  if (value.proxyMode !== 'custom') return
  try {
    const protocol = new URL(value.proxyUrl).protocol
    if (!['http:', 'https:', 'socks5:'].includes(protocol)) throw new Error('protocol')
  } catch { context.addIssue({ code: 'custom', path: ['proxyUrl'], message: '代理地址必须使用 HTTP、HTTPS 或 SOCKS5 URL' }) }
})
export type Settings = z.infer<typeof SettingsSchema>

export interface TaskRecord {
  id: string
  source: DownloadSource
  filters: DownloadFilter
  status: TaskStatus
  total: number
  completed: number
  failed: number
  message: string
  force: boolean
  createdAt: string
  updatedAt: string
}

export interface PreviewResult { count: number; imageCount: number; sample: ArtworkSummary[]; warnings: string[] }
export interface ArtworkSummary { id: string; title: string; authorName: string; type: 'illust' | 'manga' | 'ugoira' }
export interface AuthStatus { loggedIn: boolean; userId?: string; userName?: string }
export interface UpdateResult { available: boolean; current: string; latest?: string; url?: string; error?: string }
export interface ProxyTestResult { ok: boolean; latencyMs?: number; message: string }

export interface PixivPage { index: number; original: string; width?: number; height?: number }
export interface UgoiraFrame { file: string; delay: number }
export interface PixivArtwork {
  id: string
  title: string
  description: string
  userId: string
  userName: string
  type: 'illust' | 'manga' | 'ugoira'
  tags: string[]
  createDate: string
  uploadDate: string
  aiType: number
  xRestrict: number
  bookmarkCount: number
  viewCount: number
  likeCount: number
  sourceUrl: string
  pages: PixivPage[]
  ugoira?: { originalSrc: string; frames: UgoiraFrame[] }
}
