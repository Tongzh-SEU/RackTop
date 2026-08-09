import { useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, ArrowRight, Database, FolderGit2, Pencil, Plus, RefreshCw, Server as ServerIcon, Trash2, X } from 'lucide-react'
import type { Project, Server } from '../types/models'

function formatSize(bytes: number) {
  if (!bytes) return '尚未统计'
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function ProjectGrid({ items, allProjects, servers, busyTargets, onEdit, onDelete, onInspect, onSync }: {
  items: Project[]; allProjects: Project[]; servers: Server[]; busyTargets: Set<string>
  onEdit: (project: Project) => void; onDelete: (project: Project) => void
  onInspect: (project: Project) => void; onSync: (project: Project, targetServerId: string) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const resize = () => grid.querySelectorAll<HTMLElement>('.project-card-wrap').forEach((item) => {
      item.style.gridRowEnd = `span ${Math.ceil(item.scrollHeight / 4) + 3}`
    })
    const observer = new ResizeObserver(resize)
    observer.observe(grid); resize()
    return () => observer.disconnect()
  }, [items])
  return <div className="project-grid" ref={gridRef}>{items.map((project) => {
    const source = servers.find((server) => server.id === project.sourceServerId)
    const related = project.kind === 'project'
      ? project.datasetIds.map((id) => allProjects.find((item) => item.id === id)).filter((item): item is Project => Boolean(item))
      : allProjects.filter((item) => item.kind === 'project' && item.datasetIds.includes(project.id))
    return <article className="panel project-card-wrap" key={project.id}>
      <header className="project-card__header"><span className={`project-card__icon project-card__icon--${project.kind}`}>{project.kind === 'project' ? <FolderGit2 size={18} /> : <Database size={18} />}</span><div><h3>{project.name}</h3><p>{source?.name ?? '主服务器已移除'} · {project.sourcePath}</p></div><div className="project-card__tools"><button className="icon-button" onClick={() => onEdit(project)} aria-label={`编辑 ${project.name}`}><Pencil size={14} /></button><button className="icon-button project-delete" onClick={() => onDelete(project)} aria-label={`删除 ${project.name}`}><Trash2 size={14} /></button></div></header>
      <div className="project-card__source"><ServerIcon size={14} /><span><small>主服务器</small><strong>{source?.name ?? '不可用'}</strong></span><span><small>数据量</small><strong>{formatSize(project.sourceSizeBytes)}</strong></span><button className="button button--secondary button--small" onClick={() => onInspect(project)}>重新检测</button></div>
      {related.length > 0 && <div className="project-card__relations"><span>{project.kind === 'project' ? '附属数据集' : '用于项目'}</span><div>{related.map((item) => <em key={item.id}>{project.kind === 'project' ? <Database size={11} /> : <FolderGit2 size={11} />}{item.name}</em>)}</div><small>{project.kind === 'project' ? '数据集需单独同步' : '不会随项目自动同步'}</small></div>}
      <div className="project-card__targets">{project.targets.map((target) => {
        const server = servers.find((item) => item.id === target.serverId)
        const busy = busyTargets.has(`${project.id}:${target.serverId}`)
        return <div className="project-target" key={target.serverId}><span className={`project-target__state is-${target.status}`}>{target.status === 'offline' || target.status === 'error' ? <AlertCircle size={13} /> : <ArrowRight size={13} />}</span><div><strong>{server?.name ?? '服务器已移除'}</strong><small>{target.path}</small><em>{target.status === 'synced' ? '已同步' : target.status === 'found' ? '已找到同名目录' : target.status === 'missing' ? '首次同步时创建' : target.error ?? '等待检测'}</em></div><button className="button button--primary button--small" disabled={busy || !server || !project.sourceExists} onClick={() => onSync(project, target.serverId)}><RefreshCw className={busy ? 'spin' : ''} size={13} />{busy ? '同步中' : '同步'}</button></div>
      })}</div>
    </article>
  })}</div>
}

export function ProjectView(props: { projects: Project[]; servers: Server[]; busyTargets: Set<string>; onAdd: () => void; onEdit: (project: Project) => void; onDelete: (project: Project) => void; onInspect: (project: Project) => void; onSync: (project: Project, targetServerId: string) => void }) {
  const projectItems = props.projects.filter((item) => item.kind === 'project')
  const datasets = props.projects.filter((item) => item.kind === 'dataset')
  if (props.projects.length === 0) return <div className="empty-state"><span className="empty-state__icon"><FolderGit2 size={26} /></span><h2>还没有项目或数据集</h2><p>添加一个主目录，选择需要同步的服务器，就能在这里统一维护跨服务器副本。</p><div><button className="button button--primary" onClick={props.onAdd}><Plus size={16} />添加同步对象</button></div></div>
  return <div className="project-view"><div className="project-view__toolbar"><p>主服务器作为唯一来源，按需同步到选中的服务器。</p><button className="button button--primary" onClick={props.onAdd}><Plus size={16} />添加</button></div>{projectItems.length > 0 && <section className="project-section"><header><div><FolderGit2 size={16} /><span><strong>项目</strong><small>{projectItems.length} 个</small></span></div></header><ProjectGrid items={projectItems} allProjects={props.projects} {...props} /></section>}{datasets.length > 0 && <section className="project-section"><header><div><Database size={16} /><span><strong>数据集</strong><small>{datasets.length} 个</small></span></div></header><ProjectGrid items={datasets} allProjects={props.projects} {...props} /></section>}</div>
}

export function ProjectDeleteDialog({ project, onClose, onDelete }: { project: Project; onClose: () => void; onDelete: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <div className="scrim"><section className="sheet project-delete-sheet" role="alertdialog" aria-modal="true" aria-labelledby="project-delete-title"><header className="sheet__header"><div><p className="eyebrow">移除同步配置</p><h2 id="project-delete-title">确认移除“{project.name}”？</h2></div><button className="icon-button" onClick={onClose} disabled={deleting} aria-label="关闭"><X size={18} /></button></header><div className="project-delete-body"><span><Trash2 size={22} /></span><div><p>将从 RackTop 删除此{project.kind === 'project' ? '项目' : '数据集'}的同步关系和状态。</p><small>主服务器及目标服务器上的文件不会被删除。</small></div>{error && <p className="form-error">{error}</p>}</div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose} disabled={deleting}>取消</button><button className="button button--danger" disabled={deleting} onClick={() => { setDeleting(true); setError(null); void onDelete().catch((reason) => { setError(String(reason)); setDeleting(false) }) }}>{deleting ? '移除中…' : '移除配置'}</button></footer></section></div>
}
