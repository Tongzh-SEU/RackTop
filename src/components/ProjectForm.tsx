import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, Database, Folder, FolderGit2, FolderSearch, RefreshCw, Server as ServerIcon, X } from 'lucide-react'
import type { Project, ProjectDraft, ProjectKind, ProjectPathCheck, Server } from '../types/models'
import { api } from '../services/api'

function defaultPath(name: string) {
  const safeName = name.trim().replaceAll('/', '-')
  return safeName ? `~/${safeName}` : '~/'
}

export function ProjectForm({ initial, projects, servers, onClose, onSave }: {
  initial?: Project | null
  projects: Project[]
  servers: Server[]
  onClose: () => void
  onSave: (draft: ProjectDraft, syncAfterSave: boolean) => Promise<void>
}) {
  const [draft, setDraft] = useState<ProjectDraft>(() => ({
    id: initial?.id,
    name: initial?.name ?? '',
    kind: initial?.kind ?? 'project',
    sourceServerId: initial?.sourceServerId ?? servers[0]?.id ?? '',
    sourcePath: initial?.sourcePath ?? '',
    datasetIds: initial?.datasetIds ?? [],
    targets: initial?.targets.map(({ serverId, path }) => ({ serverId, path })) ?? [],
  }))
  const [checks, setChecks] = useState<Record<string, ProjectPathCheck>>({})
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState<'save' | 'sync' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const eligibleTargets = useMemo(() => servers.filter((server) => server.id !== draft.sourceServerId), [draft.sourceServerId, servers])

  useEffect(() => {
    setDraft((current) => ({ ...current, targets: current.targets.filter((target) => target.serverId !== current.sourceServerId) }))
  }, [draft.sourceServerId])

  const availableDatasets = projects.filter((project) => project.kind === 'dataset' && project.id !== initial?.id)
  function setKind(kind: ProjectKind) { setDraft((current) => ({ ...current, kind, datasetIds: kind === 'dataset' ? [] : current.datasetIds })) }
  function toggleTarget(serverId: string, checked: boolean) {
    setChecks((current) => { const next = { ...current }; delete next[serverId]; return next })
    setDraft((current) => ({
      ...current,
      targets: checked
        ? [...current.targets, { serverId, path: defaultPath(current.name) }]
        : current.targets.filter((target) => target.serverId !== serverId),
    }))
  }
  function setTargetPath(serverId: string, path: string) {
    setChecks((current) => { const next = { ...current }; delete next[serverId]; return next })
    setDraft((current) => ({ ...current, targets: current.targets.map((target) => target.serverId === serverId ? { ...target, path } : target) }))
  }
  function selectAllTargets() {
    setDraft((current) => ({
      ...current,
      targets: eligibleTargets.map((server) => current.targets.find((target) => target.serverId === server.id) ?? { serverId: server.id, path: defaultPath(current.name) }),
    }))
  }

  async function detectPaths() {
    if (!draft.name.trim() || !draft.sourceServerId || !draft.sourcePath.trim()) {
      setError('请先填写名称、主服务器和主目录。')
      return
    }
    setChecking(true)
    setError(null)
    try {
      const results = await api.probeProjectPaths(draft)
      setChecks(Object.fromEntries(results.map((result) => [result.serverId, result])))
      setDraft((current) => ({
        ...current,
        sourcePath: results.find((result) => result.serverId === current.sourceServerId)?.suggestedPath ?? current.sourcePath,
        targets: current.targets.map((target) => {
          const result = results.find((item) => item.serverId === target.serverId)
          return result?.exists ? { ...target, path: result.suggestedPath } : target
        }),
      }))
    } catch (reason) { setError(String(reason)) } finally { setChecking(false) }
  }

  async function submit(syncAfterSave: boolean, event?: FormEvent) {
    event?.preventDefault()
    if (draft.targets.length === 0) { setError('至少选择一台目标服务器。'); return }
    setSaving(syncAfterSave ? 'sync' : 'save')
    setError(null)
    try { await onSave(draft, syncAfterSave) } catch (reason) { setError(String(reason)); setSaving(null) }
  }

  const sourceCheck = checks[draft.sourceServerId]
  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet project-form-sheet" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
        <header className="sheet__header"><div><p className="eyebrow">跨服务器同步</p><h2 id="project-form-title">{initial ? `编辑${initial.kind === 'project' ? '项目' : '数据集'}` : '添加项目和数据集'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <form className="project-form" onSubmit={(event) => void submit(false, event)}>
          <div className="project-form__body">
            <div className="project-identity-fields">
              <label>名称<input required value={draft.name} placeholder={draft.kind === 'project' ? '例如：Llama 微调项目' : '例如：ImageNet-1K'} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
              <fieldset className="project-kind-field"><legend>类型</legend><div className="segmented project-kind-segmented"><button type="button" disabled={Boolean(initial)} className={draft.kind === 'project' ? 'is-selected' : ''} onClick={() => setKind('project')}><FolderGit2 size={13} />项目</button><button type="button" disabled={Boolean(initial)} className={draft.kind === 'dataset' ? 'is-selected' : ''} onClick={() => setKind('dataset')}><Database size={13} />数据集</button></div></fieldset>
            </div>
            <section className="project-source-section" aria-label="同步来源">
              <header><span>{draft.kind === 'project' ? <FolderGit2 size={16} /> : <Database size={16} />}</span><div><strong>同步来源</strong><small>此服务器上的内容作为权威版本</small></div></header>
              <div className="project-source-fields">
                <label>主服务器<select required value={draft.sourceServerId} onChange={(event) => { setChecks({}); setDraft((current) => ({ ...current, sourceServerId: event.target.value })) }}>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label>
                <label>主目录<RemotePathInput required serverId={draft.sourceServerId} value={draft.sourcePath} ariaLabel="主目录" placeholder="~/project-name" onChange={(value) => { setChecks((current) => { const next = { ...current }; delete next[draft.sourceServerId]; return next }); setDraft((current) => ({ ...current, sourcePath: value })) }} /></label>
              </div>
              <PathStatus check={sourceCheck} idle="等待检测主目录" />
            </section>
            {draft.kind === 'project' && <section className="project-dataset-links" aria-label="关联数据集"><header><div><strong>关联数据集</strong><small>可选，仅用于展示附属关系，不会随项目自动同步</small></div><span>{draft.datasetIds.length} 个</span></header>{availableDatasets.length > 0 ? <div>{availableDatasets.map((dataset) => <label key={dataset.id} className={draft.datasetIds.includes(dataset.id) ? 'is-selected' : ''}><input type="checkbox" checked={draft.datasetIds.includes(dataset.id)} onChange={(event) => setDraft((current) => ({ ...current, datasetIds: event.target.checked ? [...current.datasetIds, dataset.id] : current.datasetIds.filter((id) => id !== dataset.id) }))} /><Database size={13} /><span><strong>{dataset.name}</strong><small>{dataset.sourcePath}</small></span></label>)}</div> : <p>当前还没有可关联的数据集，可以先保存项目，之后再编辑关联。</p>}</section>}
            <div className="project-target-heading"><div><strong>目标服务器</strong><small>可同时选择多台，每台服务器可使用不同目录</small></div><div className="project-target-heading__actions"><span>已选 {draft.targets.length} / {eligibleTargets.length} 台</span><button type="button" className="button button--secondary button--small" disabled={draft.targets.length === eligibleTargets.length} onClick={selectAllTargets}>全选</button><button type="button" className="button button--secondary button--small" disabled={draft.targets.length === 0} onClick={() => { setDraft((current) => ({ ...current, targets: [] })); setChecks({}) }}>清空</button><button type="button" className="button button--secondary button--small" disabled={checking || draft.targets.length === 0} onClick={() => void detectPaths()}><FolderSearch size={14} />{checking ? '检测中…' : '检测路径'}</button></div></div>
            <div className="project-target-list">
              {eligibleTargets.map((server) => {
                const target = draft.targets.find((item) => item.serverId === server.id)
                return <div className={`project-target-row ${target ? 'is-selected' : ''}`} key={server.id}>
                  <label className="project-target-check"><input type="checkbox" checked={Boolean(target)} onChange={(event) => toggleTarget(server.id, event.target.checked)} /><span className="project-target-server-icon"><ServerIcon size={14} /></span><span><strong>{server.name}</strong><small>{server.username}@{server.host}</small></span></label>
                  {target ? <RemotePathInput serverId={server.id} value={target.path} ariaLabel={`${server.name} 目标目录`} placeholder={defaultPath(draft.name)} onChange={(value) => setTargetPath(server.id, value)} /> : <span className="project-target-placeholder">选择后设置目标目录</span>}
                  <PathStatus check={checks[server.id]} idle={target ? '等待检测' : ''} />
                </div>
              })}
            </div>
            <p className="project-safety-note">同步由主服务器单向更新目标目录，不删除目标端独有文件；目标目录不存在时会自动创建。</p>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="sheet__footer"><button type="button" className="button button--secondary" onClick={onClose}>取消</button><button className="button button--secondary" type="submit" disabled={Boolean(saving)}><Check size={16} />{saving === 'save' ? '保存中…' : '保存'}</button><button className="button button--primary" type="button" disabled={Boolean(saving)} onClick={() => void submit(true)}><RefreshCw size={16} />{saving === 'sync' ? '正在准备…' : '保存并同步'}</button></footer>
        </form>
      </section>
    </div>
  )
}

function RemotePathInput({ serverId, value, placeholder, ariaLabel, required, onChange }: { serverId: string; value: string; placeholder: string; ariaLabel: string; required?: boolean; onChange: (value: string) => void }) {
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  useEffect(() => {
    if (!focused || !serverId || !value.trim()) { setSuggestions([]); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      void api.suggestProjectPaths(serverId, value.trim()).then((items) => {
        if (cancelled) return
        setSuggestions(items.filter((item) => item !== value))
        setActiveIndex(-1)
      }).catch(() => { if (!cancelled) setSuggestions([]) }).finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [focused, serverId, value])

  function choose(path: string) {
    onChange(path)
    setSuggestions([])
    setActiveIndex(-1)
  }
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { setSuggestions([]); setActiveIndex(-1); return }
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((current) => (current + 1) % suggestions.length) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1) }
    else if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); choose(suggestions[activeIndex]) }
  }

  const open = focused && (loading || suggestions.length > 0)
  return <div className="remote-path-input"><input required={required} role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-autocomplete="list" value={value} placeholder={placeholder} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={handleKeyDown} onChange={(event) => onChange(event.target.value)} />{open && <div className="remote-path-suggestions" role="listbox">{loading && suggestions.length === 0 ? <span>正在读取远端目录…</span> : suggestions.map((path, index) => <div key={path} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'is-active' : ''} onMouseDown={(event) => { event.preventDefault(); choose(path) }}><Folder size={13} /><code>{path}</code></div>)}</div>}</div>
}

function PathStatus({ check, idle }: { check?: ProjectPathCheck; idle: string }) {
  if (!check) return <span className="project-path-status">{idle}</span>
  if (check.error) return <span className="project-path-status is-error">连接失败</span>
  if (check.exists) return <span className="project-path-status is-found">已找到 · {check.fileCount} 个文件</span>
  return <span className="project-path-status is-missing">未找到，将创建</span>
}
