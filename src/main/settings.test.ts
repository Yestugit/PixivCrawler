import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => path.join(os.tmpdir(), 'pictures') } }))

import { AppDatabase } from './database'
import { SettingsStore } from './settings'

const temporary: string[] = []
afterEach(() => { temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })) })

describe('settings speed migration', () => {
  it('moves untouched legacy defaults to the fast profile and preserves custom values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixiv-settings-')); temporary.push(dir)
    const db = new AppDatabase(path.join(dir, 'settings.sqlite3'))
    const base = { downloadRoot: path.join(dir, 'downloads'), proxyMode: 'system', proxyUrl: '', acceptedNotice: true, githubRepo: '' }
    db.setSetting('app', JSON.stringify({ ...base, concurrency: 2, requestIntervalMs: 2000 }))
    const store = new SettingsStore(db)
    const migrated = store.get()
    expect(migrated).toMatchObject({ concurrency: 4, requestIntervalMs: 500 })
    store.set({ ...migrated, concurrency: 2, requestIntervalMs: 2000 })
    expect(store.get()).toMatchObject({ concurrency: 2, requestIntervalMs: 2000 })
    db.setSetting('speed-profile-v2', '0')
    db.setSetting('app', JSON.stringify({ ...base, concurrency: 3, requestIntervalMs: 1500 }))
    expect(store.get()).toMatchObject({ concurrency: 3, requestIntervalMs: 1500 })
    db.close()
  })
})
