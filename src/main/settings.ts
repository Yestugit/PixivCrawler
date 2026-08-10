import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { Settings } from '../shared/contracts'
import { SettingsSchema } from '../shared/contracts'
import type { AppDatabase } from './database'

function defaultDownloadRoot(): string { return path.join(app.getPath('pictures'), 'PixivCrawler') }

export function resolveDataPath(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const exeDir = path.dirname(app.getPath('exe'))
  const installedUninstaller = path.join(exeDir, 'Uninstall PixivCrawler.exe')
  const unpackedPortable = app.isPackaged && !fs.existsSync(installedUninstaller)
  const isPortable = Boolean(portableDir) || fs.existsSync(path.join(exeDir, 'portable.flag')) || unpackedPortable
  const localAppData = process.env.LOCALAPPDATA || app.getPath('appData')
  const result = isPortable ? path.join(portableDir || exeDir, 'data') : path.join(localAppData, 'PixivCrawler')
  fs.mkdirSync(result, { recursive: true })
  return result
}

export class SettingsStore {
  constructor(private readonly db: AppDatabase) {}
  get(): Settings {
    const raw = this.db.getSetting('app')
    const defaults: Settings = {
      downloadRoot: defaultDownloadRoot(), concurrency: 2, requestIntervalMs: 2000,
      proxyMode: 'system', proxyUrl: '', acceptedNotice: false, githubRepo: import.meta.env?.VITE_GITHUB_REPO ?? ''
    }
    if (!raw) return defaults
    const parsed = SettingsSchema.safeParse({ ...defaults, ...JSON.parse(raw) })
    return parsed.success ? parsed.data : defaults
  }
  set(value: Settings): Settings {
    const parsed = SettingsSchema.parse(value)
    fs.mkdirSync(parsed.downloadRoot, { recursive: true })
    this.db.setSetting('app', JSON.stringify(parsed))
    return parsed
  }
}
