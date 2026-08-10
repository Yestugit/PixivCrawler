import { contextBridge, ipcRenderer } from 'electron'
import type { TaskRecord } from '../shared/contracts'
import { channels, type PixivCrawlerApi } from '../shared/ipc-contract'

const api: PixivCrawlerApi = {
  auth: {
    getStatus: () => ipcRenderer.invoke(channels.authStatus),
    openLogin: () => ipcRenderer.invoke(channels.authOpen),
    logout: () => ipcRenderer.invoke(channels.authLogout)
  },
  sources: { preview: (input) => ipcRenderer.invoke(channels.sourcePreview, input) },
  tasks: {
    create: (input) => ipcRenderer.invoke(channels.taskCreate, input), list: () => ipcRenderer.invoke(channels.taskList),
    pause: (id) => ipcRenderer.invoke(channels.taskPause, id), resume: (id) => ipcRenderer.invoke(channels.taskResume, id),
    cancel: (id) => ipcRenderer.invoke(channels.taskCancel, id), retry: (id) => ipcRenderer.invoke(channels.taskRetry, id),
    onProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, task: TaskRecord): void => listener(task)
      ipcRenderer.on(channels.taskProgress, handler)
      return () => ipcRenderer.removeListener(channels.taskProgress, handler)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settingsGet), update: (value) => ipcRenderer.invoke(channels.settingsUpdate, value),
    testProxy: (value) => ipcRenderer.invoke(channels.settingsTestProxy, value)
  },
  app: { checkUpdates: () => ipcRenderer.invoke(channels.appCheckUpdates), openPath: (path) => ipcRenderer.invoke(channels.appOpenPath, path) }
}

contextBridge.exposeInMainWorld('pixivCrawler', api)
