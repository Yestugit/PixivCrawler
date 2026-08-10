import type { AuthStatus, CreateTaskInput, PreviewResult, ProxyTestResult, Settings, TaskRecord, UpdateResult } from './contracts'

export const channels = {
  authStatus: 'auth:status', authOpen: 'auth:open', authLogout: 'auth:logout',
  sourcePreview: 'sources:preview', taskCreate: 'tasks:create', taskList: 'tasks:list',
  taskPause: 'tasks:pause', taskResume: 'tasks:resume', taskCancel: 'tasks:cancel', taskRetry: 'tasks:retry',
  settingsGet: 'settings:get', settingsUpdate: 'settings:update', settingsTestProxy: 'settings:testProxy',
  appCheckUpdates: 'app:checkUpdates', appOpenPath: 'app:openPath', taskProgress: 'tasks:progress'
} as const

export interface PixivCrawlerApi {
  auth: { getStatus(): Promise<AuthStatus>; openLogin(): Promise<AuthStatus>; logout(): Promise<void> }
  sources: { preview(input: CreateTaskInput): Promise<PreviewResult> }
  tasks: {
    create(input: CreateTaskInput): Promise<TaskRecord>; list(): Promise<TaskRecord[]>
    pause(id: string): Promise<void>; resume(id: string): Promise<void>
    cancel(id: string): Promise<void>; retry(id: string): Promise<void>
    onProgress(listener: (task: TaskRecord) => void): () => void
  }
  settings: { get(): Promise<Settings>; update(value: Settings): Promise<Settings>; testProxy(value: Settings): Promise<ProxyTestResult> }
  app: { checkUpdates(): Promise<UpdateResult>; openPath(path: string): Promise<void> }
}
