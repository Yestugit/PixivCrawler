import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { AppDatabase } from './database'
import { SettingsStore, resolveDataPath } from './settings'
import { AuthService } from './auth'
import { PixivClient } from './pixiv'
import { ArtworkDownloader } from './downloader'
import { TaskManager } from './task-manager'
import { registerIpc, sendTaskProgress } from './ipc'

app.setName('PixivCrawler')
app.setPath('userData', resolveDataPath())

let mainWindow: BrowserWindow | undefined
let database: AppDatabase | undefined

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180, height: 780, minWidth: 980, minHeight: 650, show: false,
    backgroundColor: '#f5f3f0', title: 'PixivCrawler',
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.once('ready-to-show', () => window.show())
  return window
}

function loadWindow(window: BrowserWindow): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  mainWindow = createWindow()
  database = new AppDatabase(path.join(app.getPath('userData'), 'pixiv-crawler.sqlite3'))
  const settings = new SettingsStore(database)
  const auth = new AuthService()
  const pixiv = new PixivClient(auth, () => settings.get().requestIntervalMs, () => settings.get().concurrency)
  await pixiv.configureProxy(settings.get().proxyMode, settings.get().proxyUrl)
  const downloader = new ArtworkDownloader(auth.session, database)
  const tasks = new TaskManager(database, pixiv, downloader, settings, (task) => sendTaskProgress(mainWindow!, task))
  registerIpc(mainWindow, { auth, pixiv, settings, tasks })
  loadWindow(mainWindow)
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => database?.close())
