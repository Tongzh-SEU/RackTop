import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Check, Database, Folder, FolderGit2, FolderSearch, RefreshCw, Server as ServerIcon, X } from 'lucide-react'
import type { LinkedDatasetPlan, Project, ProjectDraft, ProjectKind, ProjectPathCheck, Server } from '../types/models'
import { api } from '../services/api'
import { defaultProjectTargetPath, isLegacyProjectNameTargetPath } from '../utils/projectPaths'

export function ProjectForm({ initial, projects, servers, onClose, onSave }: {
  initial?: Project | null
  projects: Project[]
  servers: Server[]
  onClose: () => void
  onSave: (draft: ProjectDraft, syncAfterSave: boolean, linkedDatasets: LinkedDatasetPlan[]) => Promise<void>
}) {
  const initialTargets = initial?.targets.map(({ serverId, path }) => ({
    serverId,
    path: isLegacyProjectNameTargetPath(path, initial.sourcePath, initial.name)
      ? defaultProjectTargetPath(initial.sourcePath, initial.name)
      : path,
  })) ?? []
  const [draft, setDraft] = useState<ProjectDraft>(() => ({
    id: initial?.id,
    name: initial?.name ?? '',
    kind: initial?.kind ?? 'project',
    sourceServerId: initial?.sourceServerId ?? servers[0]?.id ?? '',
    sourcePath: initial?.sourcePath ?? '',
    datasetIds: initial?.datasetIds ?? [],
    targets: initialTargets,
  }))
  const [checks, setChecks] = useState<Record<string, ProjectPathCheck>>({})
  const [checking, setChecking] = useState(false)
  const [datasetChecks, setDatasetChecks] = useState<Record<string, Record<string, ProjectPathCheck>>>({})
  const [checkingDatasets, setCheckingDatasets] = useState(false)
  const [datasetSyncIds, setDatasetSyncIds] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState<'save' | 'sync' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const datasetCheckGeneration = useRef(0)
  const sheetRef = useRef<HTMLElement>(null)
  const manuallyEditedTargets = useRef(new Set(initial?.targets.filter((target) => !isLegacyProjectNameTargetPath(target.path, initial.sourcePath, initial.name)).map((target) => target.serverId) ?? []))
  const eligibleTargets = useMemo(() => servers.filter((server) => server.id !== draft.sourceServerId), [draft.sourceServerId, servers])
  const sourceServerMissing = Boolean(initial && !servers.some((server) => server.id === draft.sourceServerId))

  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    sheet.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus()
  }, [])

  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    const focusable = () => [...sheet.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, saving])

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
        ? [...current.targets, { serverId, path: defaultProjectTargetPath(current.sourcePath, current.name) }]
        : current.targets.filter((target) => target.serverId !== serverId),
    }))
    if (!checked) manuallyEditedTargets.current.delete(serverId)
  }
  function setTargetPath(serverId: string, path: string) {
    manuallyEditedTargets.current.add(serverId)
    setChecks((current) => { const next = { ...current }; delete next[serverId]; return next })
    setDraft((current) => ({ ...current, targets: current.targets.map((target) => target.serverId === serverId ? { ...target, path } : target) }))
  }
  function selectAllTargets() {
    setDraft((current) => ({
      ...current,
      targets: eligibleTargets.map((server) => current.targets.find((target) => target.serverId === server.id) ?? { serverId: server.id, path: defaultProjectTargetPath(current.sourcePath, current.name) }),
    }))
  }

  function datasetProbeDraft(dataset: Project): ProjectDraft {
    return {
      id: dataset.id,
      name: dataset.name,
      kind: 'dataset',
      sourceServerId: dataset.sourceServerId,
      sourcePath: dataset.sourcePath,
      datasetIds: [],
      targets: draft.targets
        .filter((target) => target.serverId !== dataset.sourceServerId)
        .map((target) => ({
          serverId: target.serverId,
          path: dataset.targets.find((item) => item.serverId === target.serverId)?.path
            ?? defaultProjectTargetPath(dataset.sourcePath, dataset.name),
        })),
    }
  }

  function missingDatasetTargets(dataset: Project) {
    const checks = datasetChecks[dataset.id] ?? {}
    return datasetProbeDraft(dataset).targets.filter((target) => {
      const check = checks[target.serverId]
      return check && !check.exists && !check.error && check.matches.length === 0
    }).map((target) => ({ ...target, path: checks[target.serverId]?.suggestedPath ?? target.path }))
  }

  async function detectLinkedDatasets(datasetIds = draft.datasetIds) {
    const datasets = availableDatasets.filter((dataset) => datasetIds.includes(dataset.id))
    if (datasets.length === 0 || draft.targets.length === 0) return
    const generation = ++datasetCheckGeneration.current
    setCheckingDatasets(true)
    try {
      const results = await Promise.all(datasets.map(async (dataset) => {
        const probe = datasetProbeDraft(dataset)
        try {
          const checks = await api.probeProjectPaths(probe)
          return [dataset.id, Object.fromEntries(checks.filter((check) => check.serverId !== dataset.sourceServerId).map((check) => [check.serverId, check]))] as const
        } catch (reason) {
          return [dataset.id, Object.fromEntries(probe.targets.map((target) => [target.serverId, {
            serverId: target.serverId,
            requestedPath: target.path,
            suggestedPath: target.path,
            exists: false,
            isDirectory: false,
            sizeBytes: 0,
            fileCount: 0,
            matches: [],
            error: String(reason),
          } satisfies ProjectPathCheck]))] as const
        }
      }))
      if (generation === datasetCheckGeneration.current) setDatasetChecks((current) => ({ ...current, ...Object.fromEntries(results) }))
    } finally {
      if (generation === datasetCheckGeneration.current) setCheckingDatasets(false)
    }
  }

  useEffect(() => {
    if (draft.kind !== 'project' || draft.datasetIds.length === 0 || draft.targets.length === 0) {
      datasetCheckGeneration.current += 1
      setCheckingDatasets(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) void detectLinkedDatasets().catch(() => {})
    }, 500)
    return () => { cancelled = true; window.clearTimeout(timer) }
    // Dataset checks intentionally follow relationship and target selection changes only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kind, draft.datasetIds.join('|'), draft.targets.map((target) => `${target.serverId}:${target.path}`).join('|')])

  function setSourcePath(sourcePath: string) {
    setChecks((current) => { const next = { ...current }; delete next[draft.sourceServerId]; return next })
    setDraft((current) => ({
      ...current,
      sourcePath,
      targets: current.targets.map((target) => manuallyEditedTargets.current.has(target.serverId)
        ? target
        : { ...target, path: defaultProjectTargetPath(sourcePath, current.name) }),
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

  async function detectConfiguration() {
    await Promise.all([
      detectPaths(),
      draft.kind === 'project' && draft.datasetIds.length > 0 ? detectLinkedDatasets() : Promise.resolve(),
    ])
  }

  async function submit(syncAfterSave: boolean, event?: FormEvent) {
    event?.preventDefault()
    if (draft.targets.length === 0) { setError('至少选择一台目标服务器。'); return }
    const unsafe = [draft.sourcePath, ...draft.targets.map((target) => target.path)].find((path) => { const normalized = path.trim().replace(/\/+$/, ''); return !normalized || ['/', '~', '$HOME', '${HOME}', '.', '..'].includes(normalized) || normalized.split('/').includes('..') })
    if (unsafe) { setError('主目录和目标目录不能是根目录、Home 根目录或包含 ..'); return }
    setSaving(syncAfterSave ? 'sync' : 'save')
    setError(null)
    const linkedDatasets = availableDatasets.filter((dataset) => draft.datasetIds.includes(dataset.id)).map((dataset) => {
      const targets = missingDatasetTargets(dataset)
      return {
        datasetId: dataset.id,
        syncOnSave: syncAfterSave && datasetSyncIds.has(dataset.id) && targets.length > 0,
        targets,
      }
    })
    try { await onSave(draft, syncAfterSave, linkedDatasets) } catch (reason) { setError(String(reason)); setSaving(null) }
  }

  const sourceCheck = checks[draft.sourceServerId]
  const sourceServer = servers.find((server) => server.id === draft.sourceServerId)
  const datasetsWithMissingTargets = availableDatasets.filter((dataset) => draft.datasetIds.includes(dataset.id) && missingDatasetTargets(dataset).length > 0)
  const plannedDatasetSyncCount = datasetsWithMissingTargets.filter((dataset) => datasetSyncIds.has(dataset.id)).length
  const allMissingDatasetsPlanned = datasetsWithMissingTargets.length > 0 && plannedDatasetSyncCount === datasetsWithMissingTargets.length
  return (
    <div className="scrim" role="presentation">
      <section ref={sheetRef} className="sheet project-form-sheet" role="dialog" aria-modal="true" aria-labelledby="project-form-title">
        <header className="sheet__header"><div><p className="eyebrow">跨服务器同步</p><h2 id="project-form-title">{initial ? `编辑${initial.kind === 'project' ? '项目' : '数据集'}` : '添加同步对象'}</h2></div><button className="icon-button" onClick={onClose} disabled={Boolean(saving)} aria-label="关闭"><X size={18} /></button></header>
        <form className="project-form" onSubmit={(event) => void submit(false, event)}>
          <div className="project-form__body">
            <div className="project-identity-fields">
              <label>名称<input required value={draft.name} placeholder={draft.kind === 'project' ? '例如：Llama 微调项目' : '例如：ImageNet-1K'} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
              <fieldset className="project-kind-field"><legend>类型</legend><div className="segmented project-kind-segmented"><button type="button" disabled={Boolean(initial)} className={draft.kind === 'project' ? 'is-selected' : ''} onClick={() => setKind('project')}><FolderGit2 size={13} />项目</button><button type="button" disabled={Boolean(initial)} className={draft.kind === 'dataset' ? 'is-selected' : ''} onClick={() => setKind('dataset')}><Database size={13} />数据集</button></div></fieldset>
            </div>
            <section className="project-source-section" aria-label="同步来源">
              <header><span>{draft.kind === 'project' ? <FolderGit2 size={16} /> : <Database size={16} />}</span><div><strong>同步来源</strong><small>选择主服务器和来源目录</small></div></header>
              <div className="project-source-fields">
                <label>主服务器<select required value={draft.sourceServerId} className={sourceServerMissing ? 'is-invalid' : ''} onChange={(event) => { const sourceServerId = event.target.value; setChecks({}); setDraft((current) => ({ ...current, sourceServerId, targets: current.targets.filter((target) => target.serverId !== sourceServerId) })) }}>{sourceServerMissing && <option value={draft.sourceServerId} disabled>原主服务器已移除，请重新选择</option>}{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select><span className="project-source-server-meta">{sourceServer ? `${sourceServer.username}@${sourceServer.host}` : '请选择新的主服务器'}</span></label>
                <label className="project-source-path">主目录<RemotePathInput required serverId={draft.sourceServerId} value={draft.sourcePath} ariaLabel="主目录" placeholder="~/project-name" onChange={setSourcePath} /><PathStatus check={sourceCheck} idle="等待检测主目录" onChoose={setSourcePath} /></label>
              </div>
            </section>
            <div className="project-target-heading"><div><strong>目标服务器</strong><small>可同时选择多台，每台服务器可使用不同目录</small></div><div className="project-target-heading__actions"><span>已选 {draft.targets.length} / {eligibleTargets.length} 台</span><button type="button" className="button button--secondary button--small" disabled={draft.targets.length === eligibleTargets.length} onClick={selectAllTargets}>全选</button><button type="button" className="button button--secondary button--small" disabled={draft.targets.length === 0} onClick={() => { setDraft((current) => ({ ...current, targets: [] })); setChecks({}) }}>清空</button><button type="button" className="button button--secondary button--small" disabled={checking || checkingDatasets || draft.targets.length === 0} onClick={() => void detectConfiguration()}><FolderSearch size={14} />{checking || checkingDatasets ? '检查中…' : '检查配置'}</button></div></div>
            <div className="project-target-list">
              {eligibleTargets.map((server) => {
                const target = draft.targets.find((item) => item.serverId === server.id)
                return <div className={`project-target-row ${target ? 'is-selected' : ''}`} key={server.id}>
                  <label className="project-target-check"><input type="checkbox" checked={Boolean(target)} onChange={(event) => toggleTarget(server.id, event.target.checked)} /><span className="project-target-server-icon"><ServerIcon size={14} /></span><span><strong>{server.name}</strong><small>{server.username}@{server.host}</small></span></label>
                  {target ? <div className="project-target-path"><RemotePathInput serverId={server.id} value={target.path} ariaLabel={`${server.name} 目标目录`} placeholder={defaultProjectTargetPath(draft.sourcePath, draft.name)} onChange={(value) => setTargetPath(server.id, value)} /><PathStatus check={checks[server.id]} idle="等待检测" onChoose={(path) => setTargetPath(server.id, path)} /></div> : <span className="project-target-placeholder">选择后设置目标目录</span>}
                </div>
              })}
            </div>
            {draft.kind === 'project' && <section className="project-dataset-links" aria-label="关联数据集">
              <header><div><strong>关联数据集</strong><small>缺失副本可随“保存并同步”一并补齐</small></div><div className="project-dataset-links__actions">{checkingDatasets && <span>检查中…</span>}{datasetsWithMissingTargets.length > 1 && <button type="button" className="button button--secondary button--small" disabled={checkingDatasets} onClick={() => setDatasetSyncIds(allMissingDatasetsPlanned ? new Set() : new Set(datasetsWithMissingTargets.map((dataset) => dataset.id)))}>{allMissingDatasetsPlanned ? '清除补齐' : '全部补齐'}</button>}</div></header>
              {availableDatasets.length > 0 ? <div className="project-dataset-list">{availableDatasets.map((dataset) => {
                const linked = draft.datasetIds.includes(dataset.id)
                const checks = datasetChecks[dataset.id] ?? {}
                const targetChecks = draft.targets.map((target) => target.serverId === dataset.sourceServerId
                  ? { serverId: target.serverId, exists: true, matches: [], error: undefined } as Pick<ProjectPathCheck, 'serverId' | 'exists' | 'matches' | 'error'>
                  : checks[target.serverId]).filter(Boolean)
                const found = targetChecks.filter((check) => check?.exists).length
                const candidates = targetChecks.filter((check) => !check?.exists && !check?.error && check?.matches.length === 1).length
                const ambiguous = targetChecks.filter((check) => !check?.exists && !check?.error && (check?.matches.length ?? 0) > 1).length
                const failed = targetChecks.filter((check) => Boolean(check?.error)).length
                const checked = targetChecks.length === draft.targets.length && !checkingDatasets
                const missing = checked ? Math.max(0, draft.targets.length - found - candidates - ambiguous - failed) : 0
                const willSync = datasetSyncIds.has(dataset.id) && missing > 0
                const parts = [[found, '已存在'], [missing, '缺失'], [candidates, '候选待确认'], [ambiguous, '同名冲突'], [failed, '连接失败']].filter(([count]) => Number(count) > 0).map(([count, label]) => `${count} 台${label}`)
                const status = !linked ? '未关联' : draft.targets.length === 0 ? '请先选择目标服务器' : checkingDatasets ? '正在检查…' : !checked ? '等待检查' : parts.join(' · ') || '等待检查'
                const problem = checked && (missing > 0 || candidates > 0 || ambiguous > 0 || failed > 0)
                return <div key={dataset.id} className={`project-dataset-row${initial ? ' project-dataset-row--editing' : ''}${linked ? ' is-selected' : ''}`}>
                  <label className="project-dataset-row__identity"><input type="checkbox" checked={linked} onChange={(event) => { const selected = event.target.checked; setDraft((current) => ({ ...current, datasetIds: selected ? [...current.datasetIds, dataset.id] : current.datasetIds.filter((id) => id !== dataset.id) })); if (!selected) setDatasetSyncIds((current) => { const next = new Set(current); next.delete(dataset.id); return next }) }} /><Database size={13} /><span><strong>{dataset.name}</strong><small>{dataset.sourcePath}</small></span></label>
                  <span className={`project-dataset-row__status${problem ? ' is-warning' : checked && linked ? ' is-found' : ''}`}>{status}</span>
                  {linked && checked && missing > 0 && <label className="project-dataset-row__sync"><input type="checkbox" checked={willSync} onChange={(event) => setDatasetSyncIds((current) => { const next = new Set(current); if (event.target.checked) next.add(dataset.id); else next.delete(dataset.id); return next })} /><span>本次补齐</span></label>}
                </div>
              })}</div> : <p>暂无可关联的数据集。</p>}
            </section>}
            <p className="project-safety-note">主服务器是唯一来源。同步会将目标目录替换为完整副本；已有内容或后续修改必须先确认。</p>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="sheet__footer"><button type="button" className="button button--secondary" onClick={onClose} disabled={Boolean(saving)}>取消</button><button className="button button--secondary" type="submit" disabled={Boolean(saving)}><Check size={16} />{saving === 'save' ? '保存中…' : '保存'}</button><button className="button button--primary" type="button" disabled={Boolean(saving)} onClick={() => void submit(true)}><RefreshCw size={16} />{saving === 'sync' ? '正在准备…' : plannedDatasetSyncCount > 0 ? `保存并同步（含 ${plannedDatasetSyncCount} 个数据集）` : '保存并同步'}</button></footer>
        </form>
      </section>
    </div>
  )
}

function RemotePathInput({ serverId, value, placeholder, ariaLabel, required, onChange }: { serverId: string; value: string; placeholder: string; ariaLabel: string; required?: boolean; onChange: (value: string) => void }) {
  const listboxId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)

  useLayoutEffect(() => {
    if (!focused && inputRef.current) inputRef.current.scrollLeft = inputRef.current.scrollWidth
  }, [focused, value])

  useEffect(() => {
    if (!focused || !serverId || !value.trim()) { setSuggestions([]); setSuggestionError(null); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      void api.suggestProjectPaths(serverId, value.trim()).then((items) => {
        if (cancelled) return
        setSuggestionError(null)
        setSuggestions(items.filter((item) => item !== value))
        setActiveIndex(-1)
      }).catch((reason) => { if (!cancelled) { setSuggestions([]); setSuggestionError(String(reason).replace(/^Error:\s*/, '')) } }).finally(() => { if (!cancelled) setLoading(false) })
    }, 650)
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

  const open = focused && (loading || suggestions.length > 0 || Boolean(suggestionError))
  return <div className="remote-path-input"><input ref={inputRef} required={required} role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-autocomplete="list" aria-controls={open ? listboxId : undefined} aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined} value={value} placeholder={placeholder} onFocus={(event) => { setFocused(true); event.currentTarget.setSelectionRange(value.length, value.length); event.currentTarget.scrollLeft = event.currentTarget.scrollWidth }} onBlur={() => setFocused(false)} onKeyDown={handleKeyDown} onChange={(event) => onChange(event.target.value)} />{open && <div id={listboxId} className="remote-path-suggestions" role="listbox">{loading && suggestions.length === 0 ? <span>正在读取远端目录…</span> : suggestionError ? <span className="is-error" role="alert">无法读取目录：{suggestionError}</span> : suggestions.map((path, index) => <div id={`${listboxId}-${index}`} key={path} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'is-active' : ''} onMouseDown={(event) => { event.preventDefault(); choose(path) }}><Folder size={13} /><code>{path}</code></div>)}</div>}</div>
}

function PathStatus({ check, idle, onChoose }: { check?: ProjectPathCheck; idle: string; onChoose?: (path: string) => void }) {
  if (!check) return <span className="project-path-status">{idle}</span>
  if (check.error) return <span className="project-path-status is-error">连接失败</span>
  if (!check.exists && check.matches.length === 1) return <span className="project-path-status is-missing">找到同名路径 <code>{check.matches[0]}</code>{onChoose && <button type="button" className="button button--secondary button--small" onClick={() => onChoose(check.matches[0])}>采用</button>}</span>
  if (!check.exists && check.matches.length > 1) return <span className="project-path-status is-missing">找到 {check.matches.length} 个同名路径，请从目录联想中选择</span>
  if (check.exists) return <span className="project-path-status is-found">已找到 · {check.fileCount} 个文件{check.modifiedAt ? ` · 更新于 ${new Date(check.modifiedAt * 1_000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}</span>
  return <span className="project-path-status is-missing">未找到，将创建</span>
}
