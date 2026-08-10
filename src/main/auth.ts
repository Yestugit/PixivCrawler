import { BrowserWindow, session, type Session } from 'electron'
import type { AuthStatus } from '../shared/contracts'

const ALLOWED = new Set(['pixiv.net', 'www.pixiv.net', 'accounts.pixiv.net'])

export class AuthService {
  readonly session: Session
  private loginWindow?: BrowserWindow

  constructor() {
    this.session = session.fromPartition('persist:pixiv-auth')
    this.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  }

  async getStatus(): Promise<AuthStatus> {
    const cookies = await this.session.cookies.get({ domain: '.pixiv.net' })
    const php = cookies.find((c) => c.name === 'PHPSESSID')?.value
    const userId = php?.match(/^(\d+)_/)?.[1]
    if (!userId) return { loggedIn: false }
    try {
      const response = await this.session.fetch(`https://www.pixiv.net/ajax/user/${userId}?full=1&lang=zh`, { headers: { Referer: 'https://www.pixiv.net/' } })
      if (!response.ok) return { loggedIn: false }
      const json = await response.json() as { error?: boolean; body?: { name?: string } }
      return json.error ? { loggedIn: false } : { loggedIn: true, userId, userName: json.body?.name }
    } catch { return { loggedIn: true, userId } }
  }

  async openLogin(): Promise<AuthStatus> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) { this.loginWindow.focus(); return this.getStatus() }
    this.loginWindow = new BrowserWindow({
      width: 1000, height: 760, title: '登录 Pixiv', show: false,
      webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
    })
    this.loginWindow.webContents.on('will-navigate', (event, url) => { if (!this.allowed(url)) event.preventDefault() })
    this.loginWindow.webContents.setWindowOpenHandler(({ url }) => this.allowed(url) ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true } } } : { action: 'deny' })
    this.loginWindow.once('ready-to-show', () => this.loginWindow?.show())
    await this.loginWindow.loadURL('https://accounts.pixiv.net/login?return_to=https%3A%2F%2Fwww.pixiv.net%2F')
    return new Promise((resolve) => {
      const check = async (): Promise<void> => {
        const status = await this.getStatus()
        if (status.loggedIn) { this.loginWindow?.close(); resolve(status) }
      }
      this.loginWindow?.webContents.on('did-navigate', check)
      this.loginWindow?.webContents.on('did-navigate-in-page', check)
      this.loginWindow?.once('closed', async () => { this.loginWindow = undefined; resolve(await this.getStatus()) })
    })
  }

  async logout(): Promise<void> {
    await this.session.clearStorageData({ storages: ['cookies', 'localstorage', 'cachestorage', 'serviceworkers'] })
    await this.session.clearCache()
  }
  private allowed(value: string): boolean { try { return new URL(value).protocol === 'https:' && ALLOWED.has(new URL(value).hostname) } catch { return false } }
}
