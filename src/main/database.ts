import { DatabaseSync } from 'node:sqlite'
import type { CreateTaskInput, PixivArtwork, TaskRecord, TaskStatus } from '../shared/contracts'
import { FilterSchema, SourceSchema, TaskStatusSchema } from '../shared/contracts'

export class AppDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, source_json TEXT NOT NULL, filters_json TEXT NOT NULL,
        status TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
        inspected_candidates INTEGER NOT NULL DEFAULT 0,
        candidate_total INTEGER NOT NULL DEFAULT 0,
        matched_images INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '', force INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_items (
        task_id TEXT NOT NULL, artwork_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
        error TEXT, PRIMARY KEY (task_id, artwork_id)
      );
      CREATE TABLE IF NOT EXISTS artworks (
        id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        artwork_id TEXT NOT NULL, page_index INTEGER NOT NULL, format TEXT NOT NULL,
        path TEXT NOT NULL, size INTEGER NOT NULL, completed_at TEXT NOT NULL,
        PRIMARY KEY (artwork_id, page_index, format)
      );
      CREATE TABLE IF NOT EXISTS task_files (
        task_id TEXT NOT NULL, artwork_id TEXT NOT NULL, page_index INTEGER NOT NULL, format TEXT NOT NULL,
        path TEXT NOT NULL, size INTEGER NOT NULL, completed_at TEXT NOT NULL,
        PRIMARY KEY (task_id, artwork_id, page_index, format)
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `)
    const hasVersion2 = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get()
    if (!hasVersion2) {
      const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      const names = new Set(columns.map((column) => column.name))
      if (!names.has('inspected_candidates')) this.db.exec('ALTER TABLE tasks ADD COLUMN inspected_candidates INTEGER NOT NULL DEFAULT 0')
      if (!names.has('candidate_total')) this.db.exec('ALTER TABLE tasks ADD COLUMN candidate_total INTEGER NOT NULL DEFAULT 0')
      if (!names.has('matched_images')) this.db.exec('ALTER TABLE tasks ADD COLUMN matched_images INTEGER NOT NULL DEFAULT 0')
      this.db.prepare('INSERT INTO schema_migrations(version) VALUES (2)').run()
    }
    const hasVersion3 = this.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 3').get()
    if (!hasVersion3) {
      const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      if (!columns.some((column) => column.name === 'resolution_json')) this.db.exec('ALTER TABLE tasks ADD COLUMN resolution_json TEXT')
      this.db.prepare('INSERT INTO schema_migrations(version) VALUES (3)').run()
    }
    this.db.prepare(`UPDATE tasks SET status = 'paused', message = '应用上次退出，任务已暂停' WHERE status IN ('resolving','queued','downloading','converting')`).run()
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
  }
  createTask(id: string, input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString()
    this.db.prepare(`INSERT INTO tasks(id,source_json,filters_json,status,message,force,created_at,updated_at)
      VALUES(?,?,?,'resolving','正在解析来源',?,?,?)`).run(id, JSON.stringify(input.source), JSON.stringify(input.filters), input.force ? 1 : 0, now, now)
    return this.getTask(id)!
  }
  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.mapTask(row) : undefined
  }
  listTasks(): TaskRecord[] {
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((r) => this.mapTask(r))
  }
  updateTask(id: string, patch: Partial<Pick<TaskRecord, 'status' | 'total' | 'completed' | 'failed' | 'message' | 'inspectedCandidates' | 'candidateTotal' | 'matchedImages'>>): TaskRecord {
    const current = this.getTask(id)
    if (!current) throw new Error('任务不存在')
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    this.db.prepare(`UPDATE tasks SET status=?,total=?,completed=?,failed=?,message=?,inspected_candidates=?,candidate_total=?,matched_images=?,updated_at=? WHERE id=?`).run(
      next.status, next.total, next.completed, next.failed, next.message, next.inspectedCandidates,
      next.candidateTotal, next.matchedImages, next.updatedAt, id)
    return next
  }
  addItems(taskId: string, ids: string[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO task_items(task_id,artwork_id) VALUES(?,?)')
    this.db.exec('BEGIN')
    try { ids.forEach((id) => insert.run(taskId, id)); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  listPendingItems(taskId: string): string[] {
    return (this.db.prepare(`SELECT artwork_id FROM task_items WHERE task_id=? AND status != 'completed' ORDER BY rowid`).all(taskId) as { artwork_id: string }[]).map((r) => r.artwork_id)
  }
  setItem(taskId: string, artworkId: string, status: string, error?: string): void {
    this.db.prepare('UPDATE task_items SET status=?,error=? WHERE task_id=? AND artwork_id=?').run(status, error ?? null, taskId, artworkId)
  }
  saveArtwork(artwork: PixivArtwork): void {
    this.db.prepare(`INSERT INTO artworks(id,json,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at`).run(artwork.id, JSON.stringify(artwork), new Date().toISOString())
  }
  getResolution(taskId: string): unknown | undefined {
    const row = this.db.prepare('SELECT resolution_json FROM tasks WHERE id=?').get(taskId) as { resolution_json: string | null } | undefined
    return row?.resolution_json ? JSON.parse(row.resolution_json) : undefined
  }
  setResolution(taskId: string, value: unknown): void {
    this.db.prepare('UPDATE tasks SET resolution_json=?,updated_at=? WHERE id=?').run(JSON.stringify(value), new Date().toISOString(), taskId)
  }
  clearResolution(taskId: string): void {
    this.db.prepare('UPDATE tasks SET resolution_json=NULL,updated_at=? WHERE id=?').run(new Date().toISOString(), taskId)
  }
  getArtwork(id: string): PixivArtwork | undefined {
    const row = this.db.prepare('SELECT json FROM artworks WHERE id=?').get(id) as { json: string } | undefined
    return row ? JSON.parse(row.json) as PixivArtwork : undefined
  }
  recordFile(artworkId: string, page: number, format: string, path: string, size: number): void {
    this.db.prepare(`INSERT INTO files(artwork_id,page_index,format,path,size,completed_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(artwork_id,page_index,format) DO UPDATE SET path=excluded.path,size=excluded.size,completed_at=excluded.completed_at`).run(
      artworkId, page, format, path, size, new Date().toISOString())
  }
  hasFile(artworkId: string, page: number, format: string, path: string, size: number): boolean {
    const row = this.db.prepare('SELECT path,size FROM files WHERE artwork_id=? AND page_index=? AND format=?').get(artworkId, page, format) as { path: string; size: number } | undefined
    return row?.path === path && row.size === size
  }
  recordTaskFile(taskId: string, artworkId: string, page: number, format: string, path: string, size: number): void {
    this.db.prepare(`INSERT INTO task_files(task_id,artwork_id,page_index,format,path,size,completed_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(task_id,artwork_id,page_index,format) DO UPDATE SET path=excluded.path,size=excluded.size,completed_at=excluded.completed_at`).run(
      taskId, artworkId, page, format, path, size, new Date().toISOString())
  }
  hasTaskFile(taskId: string, artworkId: string, page: number, format: string, path: string, size: number): boolean {
    const row = this.db.prepare('SELECT path,size FROM task_files WHERE task_id=? AND artwork_id=? AND page_index=? AND format=?')
      .get(taskId, artworkId, page, format) as { path: string; size: number } | undefined
    return row?.path === path && row.size === size
  }
  itemCounts(taskId: string): { total: number; completed: number; failed: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM task_items WHERE task_id=?`).get(taskId) as Record<string, number | null>
    return { total: Number(row.total ?? 0), completed: Number(row.completed ?? 0), failed: Number(row.failed ?? 0) }
  }
  close(): void { this.db.close() }

  private mapTask(row: Record<string, unknown>): TaskRecord {
    return {
      id: String(row.id), source: SourceSchema.parse(JSON.parse(String(row.source_json))),
      filters: FilterSchema.parse(JSON.parse(String(row.filters_json))), status: TaskStatusSchema.parse(row.status) as TaskStatus,
      total: Number(row.total), completed: Number(row.completed), failed: Number(row.failed), message: String(row.message),
      inspectedCandidates: Number(row.inspected_candidates), candidateTotal: Number(row.candidate_total), matchedImages: Number(row.matched_images),
      force: Boolean(row.force), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
    }
  }
}
