import fs from 'node:fs'
import path from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'

test('launches the sandboxed desktop shell and exposes the typed bridge', async () => {
  const data = path.join(process.cwd(), '.e2e-data')
  fs.rmSync(data, { recursive: true, force: true })
  const executablePath = process.env.PIXIVCRAWLER_E2E_EXE
  const application = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ['.'], env: { ...process.env, PORTABLE_EXECUTABLE_DIR: data }
  })
  try {
    const window = await application.firstWindow()
    await expect(window).toHaveTitle('PixivCrawler')
    await expect(window.getByText('任务队列', { exact: true }).first()).toBeVisible()
    expect(await window.evaluate(() => Object.keys(window.pixivCrawler).sort())).toEqual(['app', 'auth', 'settings', 'sources', 'tasks'])
    expect((await window.evaluate(() => window.pixivCrawler.settings.get())).acceptedNotice).toBe(false)
    await expect(window.getByRole('heading', { name: '用于个人作品归档' })).toBeVisible()
  } finally { await application.close(); fs.rmSync(data, { recursive: true, force: true }) }
})
