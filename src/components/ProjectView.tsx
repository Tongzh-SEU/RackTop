import { useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Box, CheckCircle2, Database, FolderGit2, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Server as ServerIcon, Trash2, TriangleAlert, X } from 'lucide-react'
import type { Project, ProjectKind, ProjectSyncProgress, Server } from '../types/models'

export function formatProjectSize(bytes: number) {
  if (!bytes) return '尚未统计'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatProjectTime(timestamp?: number | null) {
  if (!timestamp) return '尚未记录'
  return new Date(timestamp * 1_000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatProjectDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '计算中'
  if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`
  return `约 ${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)} 小时`
}

function projectKindLabel(kind: ProjectKind) {
  return kind === 'project' ? '项目' : kind === 'dataset' ? '数据集' : '模型'
}

function ProjectKindIcon({ kind, size }: { kind: ProjectKind; size: number }) {
  return kind === 'project' ? <FolderGit2 size={size} /> : kind === 'dataset' ? <Database size={size} /> : <Box size={size} />
}

export function projectCardRowSpan(height: number, rowHeight: number, rowGap: number) {
  return Math.max(1, Math.ceil((height + rowGap) / (rowHeight + rowGap)))
}

export function syncableProjectTargets(project: Project) {
  return project.targets.filter((target) => ['unknown', 'found', 'missing', 'paused', 'error'].includes(target.status))
}

export function projectCardState(project: Project, busy: boolean, activeSyncCount = 0) {
  const count = (statuses: string[]) => project.targets.filter((target) => statuses.includes(target.status)).length
  const syncing = count(['syncing'])
  const conflicts = count(['conflict'])
  const errors = count(['error', 'offline'])
  const pending = syncableProjectTargets(project).length
  if (busy || syncing > 0 || activeSyncCount > 0) return { kind: 'syncing', label: `${Math.max(1, syncing, activeSyncCount)} 个同步中` }
  if (conflicts > 0) return { kind: 'conflict', label: `${conflicts} 个冲突` }
  if (errors > 0) return { kind: 'error', label: `${errors} 个异常` }
  if (pending > 0) return { kind: 'pending', label: `${pending} 个待更新` }
  if (project.targets.length > 0) return { kind: 'synced', label: '已同步' }
  return null
}

type ProjectGridProps = {
  items: Project[]
  allProjects: Project[]
  servers: Server[]
  busyTargets: Set<string>
  syncProgress: ProjectSyncProgress[]
  preparingProjectIds: Set<string>
  onEdit: (project: Project) => void
  onLaunch?: (project: Project) => void
  onDelete: (project: Project) => void
  onInspect: (project: Project) => void
  onSync: (project: Project, targetServerId: string) => void
  onCancel: (projectId: string, targetServerId: string) => void
  onSyncAll: (project: Project) => void
}

function ProjectGrid({ items, allProjects, servers, busyTargets, syncProgress, preparingProjectIds, onEdit, onLaunch, onDelete, onInspect, onSync, onCancel, onSyncAll }: ProjectGridProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [inspectingProjectIds, setInspectingProjectIds] = useState<Set<string>>(new Set())
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const cards = [...grid.querySelectorAll<HTMLElement>('.project-card-wrap')]
    const resize = () => {
      const styles = getComputedStyle(grid)
      const rowHeight = Number.parseFloat(styles.gridAutoRows) || 4
      const rowGap = Number.parseFloat(styles.rowGap) || 0
      cards.forEach((item) => { item.style.gridRowEnd = `span ${projectCardRowSpan(item.scrollHeight, rowHeight, rowGap)}` })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(grid)
    cards.forEach((card) => observer.observe(card))
    resize()
    return () => observer.disconnect()
  }, [items])

  function inspect(project: Project) {
    if (inspectingProjectIds.has(project.id)) return
    setInspectingProjectIds((current) => new Set(current).add(project.id))
    Promise.resolve(onInspect(project)).finally(() => {
      setInspectingProjectIds((current) => {
        const next = new Set(current)
        next.delete(project.id)
        return next
      })
    }).catch(() => {})
  }

  return <div className="project-grid" ref={gridRef}>{items.map((project) => {
    const source = servers.find((server) => server.id === project.sourceServerId)
    const preparing = preparingProjectIds.has(project.id)
    const inspecting = inspectingProjectIds.has(project.id)
    const projectBusy = preparing || [...busyTargets].some((key) => key.startsWith(`${project.id}:`))
    const activeSyncTargetIds = new Set([
      ...project.targets.filter((target) => target.status === 'syncing').map((target) => target.serverId),
      ...[...busyTargets].filter((key) => key.startsWith(`${project.id}:`)).map((key) => key.slice(project.id.length + 1)),
      ...syncProgress.filter((progress) => progress.projectId === project.id).map((progress) => progress.targetServerId),
    ])
    const syncableTargets = syncableProjectTargets(project)
    const cardState = source ? projectCardState(project, projectBusy, activeSyncTargetIds.size) : { kind: 'error', label: '主服务器已移除' }
    const related = project.kind === 'project'
      ? [...project.datasetIds, ...project.modelIds].map((id) => allProjects.find((item) => item.id === id)).filter((item): item is Project => Boolean(item))
      : allProjects.filter((item) => item.kind === 'project' && (project.kind === 'dataset' ? item.datasetIds : item.modelIds).includes(project.id))
    const relatedPresence = project.kind === 'project' ? Object.fromEntries(related.map((resource) => {
      let missing = 0
      let unknown = 0
      for (const target of project.targets) {
        if (target.serverId === resource.sourceServerId) continue
        const resourceTarget = resource.targets.find((item) => item.serverId === target.serverId)
        if (!resourceTarget) unknown += 1
        else if (!resourceTarget.exists || ['missing', 'error', 'offline'].includes(resourceTarget.status)) missing += 1
      }
      return [resource.id, { missing, unknown }]
    })) : {}

    return <article className={`panel project-card-wrap${source ? '' : ' is-source-missing'}${projectBusy ? ' is-syncing' : ''}`} key={project.id}>
      <header className="project-card__header">
        <span className={`project-card__icon project-card__icon--${project.kind}`}><ProjectKindIcon kind={project.kind} size={18} /></span>
        <div>
          <div className="project-card__title"><h3>{project.name}</h3>{cardState && <span className={`project-state-label is-${cardState.kind}`}>{cardState.kind === 'conflict' || cardState.kind === 'error' ? <TriangleAlert size={11} /> : cardState.kind === 'synced' ? <CheckCircle2 size={11} /> : null}{cardState.label}</span>}</div>
          <p>{project.sourcePath}</p>
          {related.length > 0 && <div className="project-card__relations">{related.map((item) => {
            const presence = relatedPresence[item.id]
            const relationState = presence?.missing ? `缺 ${presence.missing}` : presence?.unknown ? '待检测' : ''
            return <em key={item.id} className={presence?.missing ? 'is-missing' : presence?.unknown ? 'is-unknown' : ''}>{project.kind === 'project' ? <ProjectKindIcon kind={item.kind} size={11} /> : <FolderGit2 size={11} />}<span title={item.name}>{item.name}</span>{relationState && <small>{relationState}</small>}</em>
          })}</div>}
        </div>
        <div className="project-card__tools">{project.kind === 'project' && onLaunch && <button className="icon-button project-launch" disabled={projectBusy || !source} onClick={() => onLaunch(project)} aria-label={`启动 ${project.name}`} title="启动任务"><Play size={14} /></button>}<button className="icon-button" disabled={projectBusy} onClick={() => onEdit(project)} aria-label={`编辑 ${project.name}`} title="编辑"><Pencil size={14} /></button><button className="icon-button project-delete" disabled={projectBusy} onClick={() => onDelete(project)} aria-label={`删除 ${project.name}`} title="移除配置"><Trash2 size={14} /></button></div>
      </header>
      <div className="project-card__source">
        <ServerIcon size={14} />
        <div className="project-card__source-summary">
          <span><small>主服务器</small><strong>{source?.name ?? '需要重新选择'}</strong></span>
          <span><small>数据量</small><strong>{source ? formatProjectSize(project.sourceSizeBytes) : '暂不可用'}</strong></span>
          <span><small>最近内容修改</small><strong>{source ? formatProjectTime(project.sourceModifiedAt) : '暂不可用'}</strong></span>
        </div>
        <div className="project-card__source-actions"><button className="button button--secondary button--small" disabled={projectBusy || inspecting || !source} onClick={() => inspect(project)}>{inspecting ? <RefreshCw className="spin" size={13} /> : <Search size={13} />}{source ? inspecting ? '检查中' : '检查状态' : '请先编辑'}</button>{(syncableTargets.length > 0 || projectBusy) && <button className="button button--primary button--small" disabled={projectBusy || inspecting || !source || !project.sourceExists} title="同步所有可执行的待更新目标" onClick={() => onSyncAll(project)}>{projectBusy && <RefreshCw className="spin" size={13} />}{preparing ? '准备同步' : projectBusy ? '同步中' : `同步待更新（${syncableTargets.length}）`}</button>}</div>
      </div>
      <div className="project-card__targets">{project.targets.map((target) => {
        const server = servers.find((item) => item.id === target.serverId)
        const progress = syncProgress.find((item) => item.projectId === project.id && item.targetServerId === target.serverId)
        const busy = busyTargets.has(`${project.id}:${target.serverId}`) || Boolean(progress)
        const status = target.status === 'syncing' ? '正在同步' : target.status === 'paused' ? '已暂停，可继续' : target.status === 'synced' ? '已同步' : target.status === 'conflict' ? '目标端已修改，需确认' : target.status === 'found' ? '来源有更新' : target.status === 'missing' ? '目标不存在，同步时创建' : target.error ?? '等待检测'
        const timestamps = [target.modifiedAt ? `修改 ${formatProjectTime(target.modifiedAt)}` : '', target.lastSyncedAt ? `同步 ${formatProjectTime(target.lastSyncedAt)}` : ''].filter(Boolean).join(' · ')
        const elapsedSeconds = progress ? Math.max(1, Math.floor(Date.now() / 1000) - progress.startedAt) : 0
        const sessionBytes = progress ? Math.max(0, progress.transferredBytes - progress.resumedBytes) : 0
        const speedBytesPerSecond = progress ? sessionBytes / elapsedSeconds : 0
        const remainingSeconds = progress && progress.totalBytes > progress.transferredBytes && speedBytesPerSecond > 0 ? (progress.totalBytes - progress.transferredBytes) / speedBytesPerSecond : 0
        const progressText = progress ? progress.state === 'preparing'
          ? '正在检查空间与续传点'
          : progress.state === 'publishing'
            ? '正在发布安全副本'
            : `${formatProjectSize(progress.transferredBytes)}${progress.totalBytes > 0 ? ` / ${formatProjectSize(progress.totalBytes)}` : ''} · ${formatProjectSize(speedBytesPerSecond)}/s${remainingSeconds > 0 ? ` · ${formatProjectDuration(remainingSeconds)}` : ''}`
          : ''
        const progressPercent = progress ? progress.state === 'publishing' ? 100 : progress.totalBytes > 0 ? Math.min(98, Math.max(2, (progress.transferredBytes / progress.totalBytes) * 100)) : 12 : 0
        return <div className="project-target" key={target.serverId}>
          <span className={`project-target__state is-${target.status}`}>{target.status === 'offline' || target.status === 'error' ? <AlertCircle size={13} /> : target.status === 'conflict' ? <TriangleAlert size={13} /> : target.status === 'synced' ? <CheckCircle2 size={13} /> : <ArrowRight size={13} />}</span>
          <div className="project-target__content"><strong>{server?.name ?? '服务器已移除'}</strong><small>{target.path}</small><em>{preparing ? '等待同步队列' : progress || busy ? '正在同步中' : timestamps || '尚未同步'}</em></div>
          <div className="project-target__action"><span className={`project-target__status is-${target.status}`} title={progressText || status}>{progressText || status}</span>{busy ? <button className="icon-button project-target__sync is-active" onClick={() => onCancel(project.id, target.serverId)} aria-label={`暂停同步到 ${server?.name ?? target.serverId}`} title="暂停"><Pause size={14} /></button> : target.status === 'synced' ? null : <button className="project-target__action-button" disabled={preparing || !server || !source || !project.sourceExists} onClick={() => onSync(project, target.serverId)} aria-label={`${target.status === 'paused' ? '继续' : target.status === 'error' ? '重试' : '同步'}到 ${server?.name ?? target.serverId}`}>{target.status === 'paused' ? <><Play size={12} />继续</> : target.status === 'error' ? <><RotateCcw size={12} />重试</> : target.status === 'conflict' ? <><TriangleAlert size={12} />处理</> : <><ArrowRight size={12} />同步</>}</button>}</div>
          {(progress || preparing) && <span className={`project-target__progress${progress ? ` is-${progress.state}` : ' is-queued'}`} role="progressbar" aria-label={`${server?.name ?? target.serverId} 同步进度`} aria-valuemin={progress ? 0 : undefined} aria-valuemax={progress ? 100 : undefined} aria-valuenow={progress ? Math.round(progressPercent) : undefined} aria-valuetext={progressText || '等待同步队列'}><i style={progress ? { transform: `scaleX(${progressPercent / 100})` } : undefined} /></span>}
        </div>
      })}</div>
    </article>
  })}</div>
}

export function sortProjectsByRecentUse(items: Project[], recentRunAt: Record<string, number> = {}) {
  return [...items].sort((left, right) => {
    const leftRunAt = recentRunAt[left.id] ?? 0
    const rightRunAt = recentRunAt[right.id] ?? 0
    if (leftRunAt || rightRunAt) {
      if (!leftRunAt) return 1
      if (!rightRunAt) return -1
      if (leftRunAt !== rightRunAt) return rightRunAt - leftRunAt
    }
    return right.createdAt - left.createdAt
  })
}

export type ProjectViewProps = Omit<ProjectGridProps, 'items' | 'allProjects'> & {
  projects: Project[]
  recentRunAt?: Record<string, number>
  onAdd: () => void
}

export function ProjectView(props: ProjectViewProps) {
  const projectItems = sortProjectsByRecentUse(props.projects.filter((item) => item.kind === 'project'), props.recentRunAt)
  const datasets = sortProjectsByRecentUse(props.projects.filter((item) => item.kind === 'dataset'), props.recentRunAt)
  const models = sortProjectsByRecentUse(props.projects.filter((item) => item.kind === 'model'), props.recentRunAt)
  const [tab, setTab] = useState<ProjectKind>(() => projectItems.length ? 'project' : datasets.length ? 'dataset' : 'model')
  const visibleItems = tab === 'project' ? projectItems : tab === 'dataset' ? datasets : models
  if (props.projects.length === 0) return <div className="empty-state"><span className="empty-state__icon"><FolderGit2 size={26} /></span><h2>还没有项目、数据集或模型</h2><p>添加一个主目录，选择需要同步的服务器，就能在这里统一维护跨服务器副本。</p><div><button className="button button--primary" onClick={props.onAdd}><Plus size={16} />添加同步对象</button></div></div>
  return <div className="detail-page project-view">
    <div className="project-view__toolbar">
      <div className="project-view__tabs" role="tablist" aria-label="项目分类">
        <button className={tab === 'project' ? 'is-active' : ''} role="tab" aria-selected={tab === 'project'} onClick={() => setTab('project')}>项目 <span>{projectItems.length}</span></button>
        <button className={tab === 'dataset' ? 'is-active' : ''} role="tab" aria-selected={tab === 'dataset'} onClick={() => setTab('dataset')}>数据集 <span>{datasets.length}</span></button>
        <button className={tab === 'model' ? 'is-active' : ''} role="tab" aria-selected={tab === 'model'} onClick={() => setTab('model')}>模型 <span>{models.length}</span></button>
      </div>
      <button className="button button--primary project-view__add" onClick={props.onAdd}><Plus size={16} />添加</button>
    </div>
    {visibleItems.length > 0 ? <ProjectGrid items={visibleItems} allProjects={props.projects} {...props} /> : <div className="project-view__empty"><span><ProjectKindIcon kind={tab} size={22} /></span><strong>还没有{projectKindLabel(tab)}</strong><p>点击右上角“添加”创建新的{projectKindLabel(tab)}同步对象。</p></div>}
  </div>
}

export function ProjectConflictDialog({ project, server, onClose, onConfirm }: { project: Project; server?: Server; onClose: () => void; onConfirm: () => void }) {
  return <div className="scrim"><section className="sheet project-conflict-sheet" role="alertdialog" aria-modal="true" aria-labelledby="project-conflict-title"><header className="sheet__header"><div><p className="eyebrow">目标端内容冲突</p><h2 id="project-conflict-title">确认更新“{server?.name ?? '目标服务器'}”？</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="project-conflict-body"><span><TriangleAlert size={22} /></span><div><p>目标目录已有内容，或在“{project.name}”上次同步后发生了修改。</p><small>继续后，目标目录将替换为主服务器的完整副本，目标端独有内容会被移除。</small></div></div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button><button className="button button--danger" onClick={onConfirm}>确认替换并同步</button></footer></section></div>
}

export function ProjectDeleteDialog({ project, onClose, onDelete }: { project: Project; onClose: () => void; onDelete: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <div className="scrim"><section className="sheet project-delete-sheet" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title"><header className="sheet__header"><div><p className="eyebrow">移除同步配置</p><h2 id="project-delete-title">确认移除“{project.name}”？</h2></div><button className="icon-button" onClick={onClose} disabled={deleting} aria-label="关闭"><X size={18} /></button></header><div className="project-delete-body"><span><Trash2 size={22} /></span><div><p>将从 RackTop 删除此{projectKindLabel(project.kind)}的同步关系和状态。</p><small>主服务器及目标服务器上的文件不会被删除。</small></div>{error && <p className="form-error">{error}</p>}</div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose} disabled={deleting}>取消</button><button className="button button--danger" disabled={deleting} onClick={() => { setDeleting(true); setError(null); void onDelete().catch((reason) => { setError(String(reason)); setDeleting(false) }) }}>{deleting ? '移除中…' : '移除配置'}</button></footer></section></div>
}
