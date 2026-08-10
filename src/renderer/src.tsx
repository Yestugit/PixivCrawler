import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AuthStatus, CreateTaskInput, DownloadFilter, DownloadSource, PreviewResult, Settings, TaskRecord } from '../shared/contracts'
import { uniqueTasks, upsertTask } from '../shared/utils'
import './style.css'

const statusText: Record<TaskRecord['status'], string> = {
  resolving: '解析中', queued: '排队中', downloading: '下载中', converting: '转换中', paused: '已暂停',
  completed: '已完成', partial: '部分失败', failed: '失败', canceled: '已取消'
}
const initialFilters: DownloadFilter = { types: ['illust', 'manga', 'ugoira'], includeTags: [], excludeTags: [], bookmarkVisibility: 'both', ai: 'include', age: 'all', minBookmarks: 0, minViews: 0, minLikes: 0 }

function App(): React.JSX.Element {
  const [page, setPage] = useState<'tasks' | 'create' | 'history' | 'settings' | 'about'>('tasks')
  const [auth, setAuth] = useState<AuthStatus>({ loggedIn: false })
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [settings, setSettings] = useState<Settings>()
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    const [nextAuth, nextTasks, nextSettings] = await Promise.all([window.pixivCrawler.auth.getStatus(), window.pixivCrawler.tasks.list(), window.pixivCrawler.settings.get()])
    setAuth(nextAuth); setTasks(uniqueTasks(nextTasks)); setSettings(nextSettings)
  }
  useEffect(() => {
    void refresh().catch((e: unknown) => setError(message(e)))
    return window.pixivCrawler.tasks.onProgress((task) => setTasks((current) => upsertTask(current, task)))
  }, [])

  const login = async (): Promise<void> => { setError(''); try { setAuth(await window.pixivCrawler.auth.openLogin()) } catch (e) { setError(message(e)) } }
  const logout = async (): Promise<void> => { await window.pixivCrawler.auth.logout(); setAuth({ loggedIn: false }) }
  const active = tasks.filter((t) => !['completed', 'canceled'].includes(t.status))
  const history = tasks.filter((t) => t.status === 'completed')

  return <div className="app-shell">
    <aside>
      <div className="brand"><div className="brand-mark">P</div><div><strong>PixivCrawler</strong><small>个人作品归档</small></div></div>
      <nav>
        <Nav active={page === 'tasks'} onClick={() => setPage('tasks')} icon="◫">任务队列 <Badge>{active.length}</Badge></Nav>
        <Nav active={page === 'create'} onClick={() => setPage('create')} icon="＋">新建任务</Nav>
        <Nav active={page === 'history'} onClick={() => setPage('history')} icon="↺">下载历史</Nav>
        <Nav active={page === 'settings'} onClick={() => setPage('settings')} icon="⚙">设置</Nav>
        <Nav active={page === 'about'} onClick={() => setPage('about')} icon="ⓘ">关于</Nav>
      </nav>
      <div className="account-card">
        <span className={`dot ${auth.loggedIn ? 'online' : ''}`} />
        <div><strong>{auth.loggedIn ? auth.userName || `用户 ${auth.userId}` : '未登录 Pixiv'}</strong><small>{auth.loggedIn ? '会话已连接' : '下载前需要登录'}</small></div>
        <button className="link" onClick={() => void (auth.loggedIn ? logout() : login())}>{auth.loggedIn ? '退出' : '登录'}</button>
      </div>
    </aside>
    <main>
      {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
      {page === 'tasks' && <Tasks title="任务队列" subtitle="任务会在应用重启后保留；未完成任务将安全地暂停。" tasks={active} empty="还没有进行中的任务" />}
      {page === 'history' && <Tasks title="下载历史" subtitle="查看已经完成的归档任务；取消的空任务不会显示在这里。" tasks={history} empty="暂无下载历史" />}
      {page === 'create' && <CreateTask auth={auth} onCreated={(task) => { setTasks((current) => upsertTask(current, task)); setPage('tasks') }} onError={setError} />}
      {page === 'settings' && settings && <SettingsPage value={settings} onChange={setSettings} onError={setError} />}
      {page === 'about' && <AboutPage />}
    </main>
    {settings && !settings.acceptedNotice && <Notice settings={settings} onAccepted={(value) => setSettings(value)} />}
  </div>
}

function Nav(props: React.PropsWithChildren<{ active: boolean; icon: string; onClick(): void }>): React.JSX.Element {
  return <button className={props.active ? 'active' : ''} onClick={props.onClick}><span className="nav-icon">{props.icon}</span>{props.children}</button>
}
function Badge({ children }: React.PropsWithChildren): React.JSX.Element { return <span className="badge">{children}</span> }

function Tasks({ title, subtitle, tasks, empty }: { title: string; subtitle: string; tasks: TaskRecord[]; empty: string }): React.JSX.Element {
  const act = async (kind: 'pause' | 'resume' | 'cancel' | 'retry', id: string): Promise<void> => window.pixivCrawler.tasks[kind](id)
  return <section><Header title={title} subtitle={subtitle} />
    {tasks.length === 0 ? <Empty text={empty} /> : <div className="task-list">{tasks.map((task) => {
      const resolving = task.status === 'resolving' && task.candidateTotal > 0
      const progress = resolving ? Math.round((task.inspectedCandidates / task.candidateTotal) * 100) : task.total ? Math.round((task.completed / task.total) * 100) : 0
      return <article className="task-card" key={task.id}>
        <div className="task-top"><div><span className={`status s-${task.status}`}>{statusText[task.status]}</span><strong>{sourceName(task.source)}</strong></div><small>{formatTime(task.updatedAt)}</small></div>
        <p>{task.message}</p><div className="progress"><span style={{ width: `${progress}%` }} /></div>
        <div className="task-bottom"><span>{resolving ? `已检查 ${task.inspectedCandidates}/${task.candidateTotal}、匹配 ${task.matchedImages} 张` : `${task.completed}/${task.total || '—'} 完成${task.failed ? ` · ${task.failed} 失败` : ''}`}</span><div>
          {['downloading', 'resolving', 'queued', 'converting'].includes(task.status) && <button onClick={() => void act('pause', task.id)}>暂停</button>}
          {['paused', 'failed', 'partial'].includes(task.status) && <button onClick={() => void act(task.status === 'paused' ? 'resume' : 'retry', task.id)}>{task.status === 'paused' ? '继续' : '重试'}</button>}
          {!['completed', 'canceled'].includes(task.status) && <button className="danger" onClick={() => void act('cancel', task.id)}>取消</button>}
        </div></div>
      </article>
    })}</div>}
  </section>
}

function CreateTask({ auth, onCreated, onError }: { auth: AuthStatus; onCreated(task: TaskRecord): void; onError(value: string): void }): React.JSX.Element {
  const [kind, setKind] = useState<DownloadSource['kind']>('artworks')
  const [value, setValue] = useState('')
  const [maxImages, setMaxImages] = useState(100)
  const [searchStrategy, setSearchStrategy] = useState<'balanced' | 'newest' | 'oldest'>('balanced')
  const [filters, setFilters] = useState<DownloadFilter>(initialFilters)
  const [force, setForce] = useState(false)
  const [preview, setPreview] = useState<PreviewResult>()
  const [busy, setBusy] = useState(false)
  const input = useMemo<CreateTaskInput>(() => ({
    source: kind === 'artworks' ? { kind, values: value.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean) } : kind === 'search' ? { kind, value: value.trim(), maxImages, strategy: searchStrategy } : kind === 'author' ? { kind, value: value.trim() } : { kind }, filters, force
  }), [kind, value, maxImages, searchStrategy, filters, force])
  const execute = async (mode: 'preview' | 'create'): Promise<void> => {
    setBusy(true); onError('')
    try {
      if (!auth.loggedIn) throw new Error('请先登录 Pixiv')
      if (mode === 'preview') setPreview(await window.pixivCrawler.sources.preview(input))
      else onCreated(await window.pixivCrawler.tasks.create(input))
    } catch (e) { onError(message(e)) } finally { setBusy(false) }
  }
  return <section><Header title="新建下载任务" subtitle="先预览匹配结果，再加入可暂停、可恢复的下载队列。" />
    <div className="panel"><h3>下载来源</h3><div className="segmented">
      {([['artworks', '作品链接'], ['search', '搜索作品'], ['author', '作者作品'], ['bookmarks', '我的收藏']] as const).map(([id, label]) => <button className={kind === id ? 'selected' : ''} onClick={() => { setKind(id); setValue(''); setPreview(undefined) }} key={id}>{label}</button>)}
    </div>
    {kind !== 'bookmarks' && <label>{kind === 'artworks' ? '作品链接或 ID（每行一个）' : kind === 'search' ? '主题、标签或 Pixiv 标签页链接' : '作者链接或 ID'}<textarea rows={kind === 'artworks' ? 5 : 2} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'artworks' ? 'https://www.pixiv.net/artworks/123456' : kind === 'search' ? '例如：リコリス・リコイル、莉可丽丝，或粘贴 Pixiv 标签页链接' : 'https://www.pixiv.net/users/123456'} /></label>}
    {kind === 'search' && <div className="form-grid search-limits">
      <label>候选检查方式<select value={searchStrategy} onChange={(e) => setSearchStrategy(e.target.value as typeof searchStrategy)}><option value="balanced">跨时间均衡（推荐）</option><option value="newest">最新优先</option><option value="oldest">最旧优先</option></select></label>
      <label>最多下载图片数<input type="number" min="1" max="100" value={maxImages} onChange={(e) => setMaxImages(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} /></label>
      <label>最低收藏数<input type="number" min="0" value={filters.minBookmarks} onChange={(e) => setFilters({ ...filters, minBookmarks: nonNegative(e.target.value) })} /></label>
      <label>最低浏览数<input type="number" min="0" value={filters.minViews} onChange={(e) => setFilters({ ...filters, minViews: nonNegative(e.target.value) })} /></label>
      <label>最低点赞数<input type="number" min="0" value={filters.minLikes} onChange={(e) => setFilters({ ...filters, minLikes: nonNegative(e.target.value) })} /></label>
      <p className="field-help">最多检查 500 个候选。跨时间均衡会覆盖新、中、旧作品并优先检查摘要收藏数较高的候选；最新/最旧优先则严格按发布时间方向检查。</p>
    </div>}
    <h3>筛选条件</h3><div className="form-grid">
      <label>作品类型<div className="checks">{(['illust', 'manga', 'ugoira'] as const).map((type) => <label key={type}><input type="checkbox" checked={filters.types.includes(type)} onChange={() => setFilters({ ...filters, types: filters.types.includes(type) ? filters.types.filter((t) => t !== type) : [...filters.types, type] })} />{{ illust: '插画', manga: '漫画', ugoira: '动图' }[type]}</label>)}</div></label>
      <label>年龄分级<select value={filters.age} onChange={(e) => setFilters({ ...filters, age: e.target.value as DownloadFilter['age'] })}><option value="all">全部可见作品</option><option value="safe">仅全年龄</option><option value="r18">仅 R-18 / R-18G</option></select></label>
      <label>开始日期<input type="date" value={filters.dateFrom || ''} onChange={(e) => setFilters({ ...filters, dateFrom: e.target.value || undefined })} /></label>
      <label>结束日期<input type="date" value={filters.dateTo || ''} onChange={(e) => setFilters({ ...filters, dateTo: e.target.value || undefined })} /></label>
      <label>必须包含的标签<input value={filters.includeTags.join(', ')} onChange={(e) => setFilters({ ...filters, includeTags: tags(e.target.value) })} placeholder="逗号分隔，需全部匹配" /></label>
      <label>排除标签<input value={filters.excludeTags.join(', ')} onChange={(e) => setFilters({ ...filters, excludeTags: tags(e.target.value) })} placeholder="逗号分隔" /></label>
      <label>AI 作品<select value={filters.ai} onChange={(e) => setFilters({ ...filters, ai: e.target.value as DownloadFilter['ai'] })}><option value="include">包含</option><option value="exclude">排除</option><option value="only">仅 AI 作品</option></select></label>
      {kind === 'bookmarks' && <label>收藏范围<select value={filters.bookmarkVisibility} onChange={(e) => setFilters({ ...filters, bookmarkVisibility: e.target.value as DownloadFilter['bookmarkVisibility'] })}><option value="both">公开和非公开</option><option value="show">仅公开</option><option value="hide">仅非公开</option></select></label>}
    </div><label className="inline-check"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />强制重新下载已有文件</label>
    {preview && <div className="preview"><strong>匹配 {preview.count} 个作品，共 {preview.imageCount} 张图片</strong>{preview.warnings.map((w) => <p key={w}>{w}</p>)}{preview.sample.map((w) => <span key={w.id}>{w.title} · {w.authorName}</span>)}</div>}
    <div className="actions"><button className="secondary" disabled={busy} onClick={() => void execute('preview')}>预览结果</button><button className="primary" disabled={busy} onClick={() => void execute('create')}>{busy ? '处理中…' : '创建任务'}</button></div>
    </div>
  </section>
}

function SettingsPage({ value, onChange, onError }: { value: Settings; onChange(value: Settings): void; onError(value: string): void }): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [result, setResult] = useState('')
  const save = async (): Promise<void> => { try { onChange(await window.pixivCrawler.settings.update(draft)); setResult('设置已保存') } catch (e) { onError(message(e)) } }
  const test = async (): Promise<void> => { const r = await window.pixivCrawler.settings.testProxy(draft); setResult(r.message) }
  const updates = async (): Promise<void> => { const r = await window.pixivCrawler.app.checkUpdates(); setResult(r.error || (r.available ? `发现新版本 ${r.latest}` : '当前已是最新版本')); if (r.available && r.url) await window.pixivCrawler.app.openPath(r.url) }
  return <section><Header title="设置" subtitle="统一控制搜索解析与图片下载的并发和请求节奏。" /><div className="panel settings-panel">
    <h3>下载</h3><label>下载根目录<input value={draft.downloadRoot} onChange={(e) => setDraft({ ...draft, downloadRoot: e.target.value })} /></label><button className="secondary compact" onClick={() => void window.pixivCrawler.app.openPath(draft.downloadRoot)}>打开目录</button>
    <div className="form-grid"><label>解析与下载并发数<input type="number" min="1" max="4" value={draft.concurrency} onChange={(e) => setDraft({ ...draft, concurrency: Number(e.target.value) })} /></label><label>请求启动间隔（秒）<input type="number" min="0.5" max="10" step="0.5" value={draft.requestIntervalMs / 1000} onChange={(e) => setDraft({ ...draft, requestIntervalMs: Number(e.target.value) * 1000 })} /></label></div>
    <h3>代理</h3><label>代理方式<select value={draft.proxyMode} onChange={(e) => setDraft({ ...draft, proxyMode: e.target.value as Settings['proxyMode'] })}><option value="system">跟随系统</option><option value="custom">自定义代理</option></select></label>{draft.proxyMode === 'custom' && <label>代理地址<input value={draft.proxyUrl} onChange={(e) => setDraft({ ...draft, proxyUrl: e.target.value })} placeholder="socks5://127.0.0.1:1080" /></label>}<button className="secondary compact" onClick={() => void test()}>测试连接</button>
    <h3>更新</h3><label>GitHub 仓库<input value={draft.githubRepo} onChange={(e) => setDraft({ ...draft, githubRepo: e.target.value })} placeholder="owner/repository（留空则隐藏更新功能）" /></label>{draft.githubRepo && <button className="secondary compact" onClick={() => void updates()}>检查更新</button>}
    {result && <p className="result">{result}</p>}<div className="actions"><button className="primary" onClick={() => void save()}>保存设置</button></div>
  </div></section>
}

function AboutPage(): React.JSX.Element {
  const open = (url: string): void => { void window.pixivCrawler.app.openPath(url) }
  return <section><Header title="关于 PixivCrawler" subtitle="个人使用的 Pixiv 作品本地归档工具。" />
    <div className="panel about-panel">
      <div className="about-intro"><div className="brand-mark about-mark">P</div><div><h2>PixivCrawler</h2><p>下载并整理当前 Pixiv 账号有权正常查看的作品，支持断点续传、任务恢复和作品元数据归档。</p></div></div>
      <h3>第一次使用</h3><ol className="guide-list">
        <li><strong>登录 Pixiv</strong><span>点击左下角“登录”，在独立窗口中手动完成密码、验证码或两步验证。</span></li>
        <li><strong>新建下载任务</strong><span>选择作品链接、搜索作品、作者作品或我的收藏，并填写来源。</span></li>
        <li><strong>设置筛选条件</strong><span>可以按类型、日期、标签、AI 标记和年龄分级筛选；主题搜索还能设置最低收藏、浏览和点赞数，最多下载 100 张图片。</span></li>
        <li><strong>预览并开始</strong><span>先检查匹配数量，再创建任务。暂停会保存当前解析和文件字节进度；临时下载错误会自动重试 3 次。</span></li>
        <li><strong>查看文件</strong><span>在“设置”中查看或修改下载根目录；每个作品会保存图片和 artwork.json 元数据。</span></li>
      </ol>
      <h3>四种下载方式</h3><div className="about-grid">
        <article><strong>作品链接</strong><p>粘贴一个或多个作品链接/ID，适合精确下载。</p></article>
        <article><strong>搜索作品</strong><p>输入主题、标签、中文译名或标签页链接，并选择跨时间均衡、最新优先或最旧优先。</p></article>
        <article><strong>作者作品</strong><p>输入作者主页链接/ID，批量归档筛选后的作品。</p></article>
        <article><strong>我的收藏</strong><p>归档当前账号的公开或非公开收藏。</p></article>
      </div>
      <h3>使用说明</h3><p className="about-note">本工具不会绕过登录、验证码、年龄/地区限制或作品权限。请仅用于个人本地归档，尊重作者版权、Pixiv 服务条款和所在地法律；不要擅自转载或用于侵权用途。</p>
      <div className="about-actions"><button className="secondary" onClick={() => open('https://github.com/Yestugit/PixivCrawler')}>GitHub 项目主页</button><button className="primary" onClick={() => open('https://github.com/Yestugit/PixivCrawler/releases')}>下载最新版本</button></div>
    </div>
  </section>
}

function Notice({ settings, onAccepted }: { settings: Settings; onAccepted(value: Settings): void }): React.JSX.Element {
  const accept = async (): Promise<void> => onAccepted(await window.pixivCrawler.settings.update({ ...settings, acceptedNotice: true }))
  return <div className="modal-backdrop"><div className="modal"><div className="notice-icon">✦</div><h2>用于个人作品归档</h2><p>PixivCrawler 只会访问你登录后本来就能查看的作品。请尊重作者版权、Pixiv 服务条款和你所在地区的法律。</p><ul><li>不会绕过验证码、年龄、地区或作品访问控制</li><li>默认低并发，并在站点限流时自动等待</li><li>下载内容不得擅自重发布或用于侵权用途</li></ul><button className="primary wide" onClick={() => void accept()}>我已了解并继续</button></div></div>
}

function Header({ title, subtitle }: { title: string; subtitle: string }): React.JSX.Element { return <header className="page-header"><h1>{title}</h1><p>{subtitle}</p></header> }
function Empty({ text }: { text: string }): React.JSX.Element { return <div className="empty"><span>◎</span><h3>{text}</h3><p>可以从“新建任务”添加作品链接、关键词搜索、作者或收藏。</p></div> }
function sourceName(source: DownloadSource): string { return source.kind === 'artworks' ? `${source.values.length} 个作品` : source.kind === 'search' ? `搜索：${source.value}` : source.kind === 'author' ? `作者 ${source.value}` : '我的收藏' }
function formatTime(value: string): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) }
function tags(value: string): string[] { return value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) }
function nonNegative(value: string): number { return Math.max(0, Math.floor(Number(value) || 0)) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
