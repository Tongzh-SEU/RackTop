import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Database, FolderGit2, LoaderCircle, MoreHorizontal, Play, Plus, RefreshCw, RotateCcw, Save, ScrollText, Server as ServerIcon, Square, TerminalSquare, Trash2, X } from 'lucide-react'
import { api } from '../services/api'
import type { LaunchProfile, ManagedRun, Project, Server, Snapshot } from '../types/models'
import { currentUserProcessCount } from '../utils/processRelations'
import { loadLaunchProfiles, loadManagedRuns, processBelongsToManagedRun, projectPathOnServer, projectWorkingDirectory, runIsObserved, runProcesses, saveLaunchProfiles, saveManagedRuns } from '../utils/managedRuns'
import type { MineProcessWarning } from '../utils/mineProcessWarnings'
import { ProcessBlocks } from './ProcessBlocks'

type ViewTab = 'running' | 'profiles' | 'recent'

function relativeDuration(timestamp: number) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000) - timestamp)
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ${Math.floor(seconds % 3_600 / 60)}m`
  return `${Math.floor(seconds / 86_400)} 天`
}

function formatMemoryMb(value: number) {
  if (value >= 1024) return `${(value / 1024).toFixed(1)} GB`
  return `${Math.round(value)} MB`
}

function formatTimestamp(timestamp?: number | null) {
  if (!timestamp) return '尚未运行'
  return new Date(timestamp * 1_000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function defaultProfile(projects: Project[]): LaunchProfile {
  const project = projects.find((item) => item.kind === 'project')
  const now = Math.floor(Date.now() / 1_000)
  const filename = project?.sourceIsDirectory === false ? project.sourcePath.split('/').pop() : null
  return { id: crypto.randomUUID(), name: project?.name ? `${project.name} 运行` : '新启动配置', projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? '~/projects', command: filename?.endsWith('.py') ? `python ${filename}` : 'python train.py', gpuCount: 1, gpuModel: null, minimumGpuMemoryGb: 0, datasetIds: project?.datasetIds ?? [], createdAt: now, updatedAt: now }
}

function demoProfiles(projects: Project[]) {
  const now = Math.floor(Date.now() / 1_000)
  const project = projects.find((item) => item.kind === 'project')
  return [
    { id: 'demo-profile-train', name: 'Llama-3 微调', projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? '~/projects/llama-finetune', command: 'python train.py --config a100.yaml', gpuCount: 2, gpuModel: 'A100', minimumGpuMemoryGb: 60, datasetIds: project?.datasetIds ?? [], createdAt: now, updatedAt: now },
    { id: 'demo-profile-eval', name: '模型评估', projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? '~/projects/model-eval', command: 'python evaluate.py', gpuCount: 1, gpuModel: null, minimumGpuMemoryGb: 20, datasetIds: [], createdAt: now, updatedAt: now },
  ] satisfies LaunchProfile[]
}

function currentUserSnapshot(snapshot: Snapshot, runs: ManagedRun[]) {
  return {
    ...snapshot,
    processes: snapshot.processes.filter((process) => process.isCurrentUser && !processBelongsToManagedRun(snapshot.serverId, process, runs)),
    cpuProcesses: snapshot.cpuProcesses.filter((process) => process.isCurrentUser && !processBelongsToManagedRun(snapshot.serverId, process, runs)),
  }
}

export function ManagedProcessView({ servers, snapshots, projects, warnings, onDismissWarning, onOpenTerminal, onNotice, onRefreshServer }: {
  servers: Server[]
  snapshots: Record<string, Snapshot>
  projects: Project[]
  warnings: MineProcessWarning[]
  onDismissWarning: (warningId: string) => void
  onOpenTerminal: (serverId: string) => void
  onNotice: (message: string) => void
  onRefreshServer: (serverId: string) => Promise<void>
}) {
  const [tab, setTab] = useState<ViewTab>('running')
  const [profiles, setProfiles] = useState<LaunchProfile[]>(() => loadLaunchProfiles())
  const [runs, setRuns] = useState<ManagedRun[]>(() => loadManagedRuns())
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [unmanagedOpen, setUnmanagedOpen] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [launchProfile, setLaunchProfile] = useState<LaunchProfile>(() => defaultProfile(projects))
  const [selectedServerId, setSelectedServerId] = useState('')
  const [assignmentMode, setAssignmentMode] = useState<'automatic' | 'manual'>('automatic')
  const [selectedGpuUuids, setSelectedGpuUuids] = useState<string[]>([])
  const [saveProfile, setSaveProfile] = useState(true)
  const [syncDependencies, setSyncDependencies] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [logRun, setLogRun] = useState<ManagedRun | null>(null)
  const [logContent, setLogContent] = useState('')
  const [loadingLog, setLoadingLog] = useState(false)
  const [pendingStop, setPendingStop] = useState<ManagedRun | null>(null)
  const [stopping, setStopping] = useState(false)

  useEffect(() => { saveLaunchProfiles(profiles) }, [profiles])
  useEffect(() => { saveManagedRuns(runs) }, [runs])

  useEffect(() => {
    setRuns((current) => {
      let changed = false
      const next = current.map((run) => {
        if (!['starting', 'unknown'].includes(run.status) || !runIsObserved(run, snapshots[run.serverId])) return run
        changed = true
        return { ...run, status: 'running' as const }
      })
      return changed ? next : current
    })
  }, [snapshots])

  useEffect(() => {
    if (api.isDesktop || profiles.length > 0 || projects.length === 0) return
    setProfiles(demoProfiles(projects))
  }, [profiles.length, projects])

  useEffect(() => {
    const active = runs.filter((run) => ['starting', 'running', 'unknown'].includes(run.status) && !runIsObserved(run, snapshots[run.serverId]) && Date.now() / 1_000 - run.startedAt > 12)
    if (active.length === 0) return
    let cancelled = false
    const check = async () => {
      const results = await Promise.all(active.map(async (run) => {
        try { return [run.id, await api.getManagedRunStatus(run.serverId, run.id, run.pid)] as const } catch { return [run.id, null] as const }
      }))
      if (cancelled) return
      const byId = new Map(results)
      setRuns((current) => {
        let changed = false
        const next = current.map((run) => {
          const status = byId.get(run.id)
          if (!status) return run
          if (status.status === 'running' && run.status !== 'running') {
            changed = true
            return { ...run, status: 'running' as const }
          }
          if (status.status === 'exited') {
            const nextStatus = status.exitCode === 0 ? 'completed' as const : 'failed' as const
            if (run.status === nextStatus && run.exitCode === status.exitCode && run.endedAt) return run
            changed = true
            return { ...run, status: nextStatus, exitCode: status.exitCode, endedAt: Math.floor(Date.now() / 1_000) }
          }
          if (status.status === 'unknown' && run.status !== 'unknown') {
            changed = true
            return { ...run, status: 'unknown' as const }
          }
          return run
        })
        return changed ? next : current
      })
    }
    void check()
    const interval = window.setInterval(check, 15_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [runs, snapshots])

  const activeRuns = runs.filter((run) => ['starting', 'running', 'unknown'].includes(run.status))
  const recentRuns = runs.filter((run) => !['starting', 'running', 'unknown'].includes(run.status)).sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))
  const activeServerIds = new Set(activeRuns.map((run) => run.serverId))
  const unmanagedServers = servers.flatMap((server) => {
    const snapshot = snapshots[server.id]
    if (!snapshot) return []
    const unmanaged = currentUserSnapshot(snapshot, activeRuns)
    return currentUserProcessCount(unmanaged) > 0 ? [{ server, snapshot: unmanaged }] : []
  })

  const selectedServer = servers.find((server) => server.id === selectedServerId)
  const selectedSnapshot = selectedServerId ? snapshots[selectedServerId] : undefined
  const selectedProject = projects.find((project) => project.id === launchProfile.projectId)
  const selectedProjectPath = selectedProject && selectedServerId ? projectWorkingDirectory(selectedProject, selectedServerId) : launchProfile.workingDirectory
  const availableGpus = useMemo(() => {
    if (!selectedSnapshot) return []
    return selectedSnapshot.gpus.filter((gpu) => gpu.memoryTotalMb > 0 && (!launchProfile.gpuModel || gpu.name.toLowerCase().includes(launchProfile.gpuModel.toLowerCase())) && (gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024 >= launchProfile.minimumGpuMemoryGb).sort((left, right) => (right.memoryTotalMb - right.memoryUsedMb) - (left.memoryTotalMb - left.memoryUsedMb))
  }, [launchProfile.gpuModel, launchProfile.minimumGpuMemoryGb, selectedSnapshot])

  useEffect(() => {
    if (!launchOpen) return
    const online = servers.filter((server) => snapshots[server.id])
    if (!selectedServerId || !online.some((server) => server.id === selectedServerId)) setSelectedServerId(online[0]?.id ?? '')
  }, [launchOpen, selectedServerId, servers, snapshots])

  useEffect(() => {
    if (!launchOpen || assignmentMode !== 'automatic') return
    setSelectedGpuUuids(availableGpus.slice(0, launchProfile.gpuCount).map((gpu) => gpu.uuid))
  }, [assignmentMode, availableGpus, launchOpen, launchProfile.gpuCount])

  function openLaunch(profile?: LaunchProfile) {
    setLaunchProfile(profile ? { ...profile } : defaultProfile(projects))
    setSelectedServerId('')
    setAssignmentMode('automatic')
    setSelectedGpuUuids([])
    setSaveProfile(Boolean(profile) || profiles.length === 0)
    setSyncDependencies(true)
    setLaunchError(null)
    setLaunchOpen(true)
  }

  function updateLaunchProfile(patch: Partial<LaunchProfile>) {
    setLaunchProfile((current) => ({ ...current, ...patch, updatedAt: Math.floor(Date.now() / 1_000) }))
  }

  async function launch(profile = launchProfile) {
    const server = servers.find((item) => item.id === selectedServerId)
    if (!server || !selectedSnapshot) { setLaunchError('请选择已连接的服务器。'); return }
    const gpuUuids = launchProfile.gpuCount > 0 ? selectedGpuUuids : []
    if (gpuUuids.length !== launchProfile.gpuCount) { setLaunchError(`当前配置需要 ${launchProfile.gpuCount} 张 GPU。`); return }
    const gpus = gpuUuids.map((uuid) => selectedSnapshot.gpus.find((gpu) => gpu.uuid === uuid)).filter(Boolean) as Snapshot['gpus']
    const workingDirectory = selectedProject ? selectedProjectPath : profile.workingDirectory
    if (!workingDirectory) { setLaunchError('所选服务器上没有项目副本，请先在“我的项目”中配置同步目标。'); return }
    setLaunching(true)
    setLaunchError(null)
    try {
      if (syncDependencies && selectedProject && selectedProject.sourceServerId !== server.id) {
        const target = selectedProject.targets.find((item) => item.serverId === server.id)
        if (target && target.status !== 'synced') await api.syncProject(selectedProject.id, server.id)
        for (const datasetId of selectedProject.datasetIds) {
          const dataset = projects.find((item) => item.id === datasetId)
          const datasetTarget = dataset?.targets.find((item) => item.serverId === server.id)
          if (dataset && dataset.sourceServerId !== server.id && datasetTarget && datasetTarget.status !== 'synced') await api.syncProject(dataset.id, server.id)
        }
      }
      const runId = crypto.randomUUID()
      const result = await api.launchManagedRun(server.id, runId, workingDirectory, profile.command, gpus.map((gpu) => gpu.index))
      const run: ManagedRun = { id: runId, profileId: saveProfile ? profile.id : null, name: profile.name.trim() || '临时任务', projectId: profile.projectId, serverId: server.id, gpuUuids, gpuIndices: gpus.map((gpu) => gpu.index), workingDirectory, command: profile.command.trim(), pid: result.pid, logPath: result.logPath, startedAt: Math.floor(Date.now() / 1_000), status: 'starting' }
      setRuns((current) => [run, ...current])
      if (saveProfile) setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)])
      setLaunchOpen(false)
      setTab('running')
      onNotice(`已在 ${server.name} 启动“${run.name}”`)
      window.setTimeout(() => void onRefreshServer(server.id), 1_200)
    } catch (reason) {
      setLaunchError(String(reason).replace(/^Error:\s*/, ''))
    } finally {
      setLaunching(false)
    }
  }

  async function restartRun(run: ManagedRun) {
    const profile: LaunchProfile = profiles.find((item) => item.id === run.profileId) ?? { id: crypto.randomUUID(), name: run.name, projectId: run.projectId, workingDirectory: run.workingDirectory, command: run.command, gpuCount: run.gpuUuids.length, minimumGpuMemoryGb: 0, datasetIds: [], createdAt: run.startedAt, updatedAt: Math.floor(Date.now() / 1_000) }
    openLaunch(profile)
    setSelectedServerId(run.serverId)
    setAssignmentMode('manual')
    setSelectedGpuUuids(run.gpuUuids)
  }

  async function openLog(run: ManagedRun) {
    setLogRun(run)
    setLogContent('')
    setLoadingLog(true)
    try { setLogContent(await api.readManagedRunLog(run.serverId, run.id)) } catch (reason) { setLogContent(`无法读取日志：${String(reason).replace(/^Error:\s*/, '')}`) } finally { setLoadingLog(false) }
  }

  async function stopRun() {
    if (!pendingStop) return
    setStopping(true)
    try {
      await api.terminateProcess(pendingStop.serverId, pendingStop.pid)
      setRuns((current) => current.map((run) => run.id === pendingStop.id ? { ...run, status: 'stopped', endedAt: Math.floor(Date.now() / 1_000) } : run))
      onNotice(`已结束“${pendingStop.name}”`)
      await onRefreshServer(pendingStop.serverId)
      setPendingStop(null)
    } catch (reason) { onNotice(`结束任务失败：${String(reason).replace(/^Error:\s*/, '')}`) } finally { setStopping(false) }
  }

  return <div className="detail-page managed-process-page">
    <div className="managed-process-toolbar">
      <div className="managed-process-tabs" role="tablist">
        <button className={tab === 'running' ? 'is-active' : ''} role="tab" aria-selected={tab === 'running'} onClick={() => setTab('running')}>运行中 <span>{activeRuns.length}</span></button>
        <button className={tab === 'profiles' ? 'is-active' : ''} role="tab" aria-selected={tab === 'profiles'} onClick={() => setTab('profiles')}>启动配置 <span>{profiles.length}</span></button>
        <button className={tab === 'recent' ? 'is-active' : ''} role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>最近结束 <span>{recentRuns.length}</span></button>
      </div>
      <button className="button button--primary managed-process-launch" onClick={() => openLaunch()}><Plus size={15} />启动任务</button>
    </div>

    {tab === 'running' && <>
      <div className="managed-process-summary"><span><strong>{activeRuns.length}</strong> 个任务</span><span><strong>{activeServerIds.size}</strong> 台服务器</span><span><strong>{activeRuns.reduce((sum, run) => sum + run.gpuUuids.length, 0)}</strong> 张 GPU</span>{warnings.some((warning) => warning.tone === 'warning') && <span className="is-warning">{warnings.filter((warning) => warning.tone === 'warning').length} 项需要注意</span>}</div>
      {warnings.filter((warning) => warning.tone === 'warning').map((warning) => <div className="managed-process-warning" key={warning.id}><AlertCircle size={15} /><span>{warning.message}</span><button className="icon-button" onClick={() => onDismissWarning(warning.id)} aria-label="忽略"><X size={13} /></button></div>)}
      {servers.filter((server) => activeRuns.some((run) => run.serverId === server.id)).map((server) => {
        const snapshot = snapshots[server.id]
        const serverRuns = activeRuns.filter((run) => run.serverId === server.id)
        return <section className="managed-server-group" key={server.id}>
          <header><div><i className={`server-row__status server-row__status--${server.status}`} /><strong>{server.name}</strong><small>{server.username}@{server.host} · {serverRuns.length} 个任务</small></div><button className="icon-button" onClick={() => onOpenTerminal(server.id)} title="打开服务器终端" aria-label={`打开 ${server.name} 终端`}><TerminalSquare size={15} /></button></header>
          <div className="managed-run-list">{serverRuns.map((run) => {
            const observed = runProcesses(run, snapshot)
            const gpuProcesses = observed.filter((process) => 'gpuUuid' in process)
            const gpuMetrics = run.gpuUuids.map((uuid) => snapshot?.gpus.find((gpu) => gpu.uuid === uuid)).filter(Boolean) as Snapshot['gpus']
            const utilization = gpuMetrics.length ? gpuMetrics.reduce((sum, gpu) => sum + gpu.utilization, 0) / gpuMetrics.length : 0
            const memoryMb = gpuProcesses.reduce((sum, process) => sum + ('memoryUsedMb' in process ? process.memoryUsedMb : 0), 0)
            const sm = gpuProcesses.length ? gpuProcesses.reduce((sum, process) => sum + (process.smUtilization ?? 0), 0) / gpuProcesses.length : 0
            const expanded = expandedRuns.has(run.id)
            return <article className={`managed-run-row ${expanded ? 'is-expanded' : ''}`} key={run.id}>
              <button className="managed-run-disclosure" onClick={() => setExpandedRuns((current) => { const next = new Set(current); if (next.has(run.id)) next.delete(run.id); else next.add(run.id); return next })} aria-label={expanded ? '收起任务' : '展开任务'}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
              <div className="managed-run-identity"><div><CircleDot size={13} /><strong>{run.name}</strong>{run.projectId && <span>项目任务</span>}</div><p>{profiles.find((profile) => profile.id === run.profileId)?.name ?? '临时任务'} · <code>{run.command}</code></p></div>
              <div className="managed-run-placement"><strong>{run.gpuIndices.length ? `GPU ${run.gpuIndices.join(', ')}` : 'CPU'}</strong><small>{run.gpuIndices.length ? `${run.gpuIndices.length} 张 GPU` : '未使用 GPU'}</small></div>
              <dl className="managed-run-metrics">{run.gpuIndices.length ? <><div><dt>UTL</dt><dd>{utilization.toFixed(0)}%</dd></div><div><dt>MEM</dt><dd>{formatMemoryMb(memoryMb)}</dd></div><div><dt>SM</dt><dd>{sm.toFixed(0)}%</dd></div></> : <><div><dt>CPU</dt><dd>{observed.reduce((sum, process) => sum + process.cpuPercent, 0).toFixed(0)}%</dd></div><div><dt>内存</dt><dd>{formatMemoryMb(observed.reduce((sum, process) => sum + ('memoryUsedBytes' in process ? process.memoryUsedBytes / 1024 ** 2 : 0), 0))}</dd></div><div><dt>进程</dt><dd>{observed.length}</dd></div></>}<div><dt>运行</dt><dd>{relativeDuration(run.startedAt)}</dd></div></dl>
              <div className="managed-run-actions"><button className="icon-button" title="打开终端" onClick={() => onOpenTerminal(server.id)}><TerminalSquare size={14} /></button><button className="icon-button" title="查看日志" onClick={() => void openLog(run)}><ScrollText size={14} /></button><button className="icon-button" title="重新启动" onClick={() => void restartRun(run)}><RotateCcw size={14} /></button><button className="icon-button is-danger" title="结束任务" onClick={() => setPendingStop(run)}><Square size={12} fill="currentColor" /></button><button className="icon-button" title="更多操作"><MoreHorizontal size={15} /></button></div>
              {expanded && <div className="managed-run-details"><dl><div><dt>工作目录</dt><dd><code>{run.workingDirectory}</code></dd></div><div><dt>任务根 PID</dt><dd><code>{run.pid}</code></dd></div><div><dt>日志</dt><dd><code>{run.logPath}</code></dd></div><div><dt>状态</dt><dd>{run.status === 'starting' ? '正在确认进程' : run.status === 'unknown' ? '等待远端确认' : '运行中'}</dd></div></dl>{observed.length > 0 ? <div className="managed-process-tree">{observed.map((process) => <div key={`${process.pid}-${'gpuUuid' in process ? process.gpuUuid : 'cpu'}`}><i /><code>PID {process.pid}</code><span>{process.command}</span><em>{'gpuIndex' in process ? `GPU ${process.gpuIndex}` : 'CPU'}</em></div>)}</div> : <p className="managed-run-waiting"><LoaderCircle className="spin" size={13} />等待下一次进程采样建立附属关系</p>}</div>}
            </article>
          })}</div>
        </section>
      })}
      {activeRuns.length === 0 && <div className="managed-process-empty"><CircleDot size={28} /><strong>没有由 RackTop 管理的任务</strong><p>启动任务后，这里会持续显示项目、GPU、进程关系和运行状态。</p><button className="button button--primary" onClick={() => openLaunch()}><Play size={14} />启动任务</button></div>}
      {unmanagedServers.length > 0 && <section className={`unmanaged-processes ${unmanagedOpen || activeRuns.length === 0 ? 'is-open' : ''}`}><button onClick={() => setUnmanagedOpen((value) => !value)}><span><strong>未关联进程</strong><small>{unmanagedServers.reduce((sum, item) => sum + currentUserProcessCount(item.snapshot), 0)} 个由终端或其他工具启动的进程</small></span>{unmanagedOpen || activeRuns.length === 0 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button><div>{unmanagedServers.map(({ server, snapshot }) => <section key={server.id}><header><ServerIcon size={14} /><strong>{server.name}</strong><small>{server.host}</small></header><ProcessBlocks snapshot={snapshot} hideEmptyBlocks /></section>)}</div></section>}
    </>}

    {tab === 'profiles' && <section className="managed-profile-view"><header><div><h2>启动配置</h2><p>保存项目、命令和资源要求，不保存密码或明文 Token。</p></div><button className="button button--secondary" onClick={() => openLaunch()}><Plus size={14} />新建配置</button></header>{profiles.length ? <div className="managed-profile-table"><div className="managed-profile-head"><span>名称与项目</span><span>启动命令</span><span>资源要求</span><span>最近运行</span><span /></div>{profiles.map((profile) => { const project = projects.find((item) => item.id === profile.projectId); const latest = runs.filter((run) => run.profileId === profile.id).sort((left, right) => right.startedAt - left.startedAt)[0]; return <div className="managed-profile-row" key={profile.id}><span><strong>{profile.name}</strong><small>{project ? `项目 · ${project.name}` : '未关联项目'}</small></span><code>{profile.command}</code><span><strong>{profile.gpuCount ? `${profile.gpuCount} × ${profile.gpuModel || 'GPU'}` : 'CPU'}</strong><small>{profile.minimumGpuMemoryGb ? `每卡空闲 ≥ ${profile.minimumGpuMemoryGb} GB` : '无显存限制'}</small></span><span>{formatTimestamp(latest?.startedAt)}</span><span><button className="button button--secondary button--small" onClick={() => openLaunch(profile)}><Play size={12} />运行</button><button className="icon-button" title="删除配置" onClick={() => setProfiles((current) => current.filter((item) => item.id !== profile.id))}><Trash2 size={13} /></button></span></div>})}</div> : <div className="managed-process-empty"><Save size={26} /><strong>还没有启动配置</strong><p>保存常用项目、命令和 GPU 要求，下次可以直接运行。</p></div>}</section>}

    {tab === 'recent' && <section className="managed-recent-view"><header><div><h2>最近结束</h2><p>仅保留 RackTop 管理任务的结果和日志入口。</p></div></header>{recentRuns.length ? <div className="managed-recent-list">{recentRuns.map((run) => { const server = servers.find((item) => item.id === run.serverId); return <div key={run.id}><span className={`managed-exit-state is-${run.status}`}>{run.status === 'completed' ? <CheckCircle2 size={13} /> : run.status === 'stopped' ? <Square size={10} fill="currentColor" /> : <AlertCircle size={13} />}</span><span><strong>{run.name}</strong><small>{server?.name ?? '服务器已移除'} · {run.gpuIndices.length ? `GPU ${run.gpuIndices.join(', ')}` : 'CPU'}</small></span><span><strong>{run.status === 'completed' ? '正常完成' : run.status === 'stopped' ? '手动结束' : `意外退出${run.exitCode == null ? '' : ` · 代码 ${run.exitCode}`}`}</strong><small>运行 {relativeDuration(run.startedAt)}</small></span><time>{formatTimestamp(run.endedAt)}</time><button className="button button--secondary button--small" onClick={() => void restartRun(run)}><RefreshCw size={12} />再次运行</button></div>})}</div> : <div className="managed-process-empty"><CheckCircle2 size={27} /><strong>没有最近结束的任务</strong><p>完成、停止或意外退出的 RackTop 任务会显示在这里。</p></div>}</section>}

    {launchOpen && <div className="scrim"><section className="sheet managed-launch-sheet" role="dialog" aria-modal="true" aria-labelledby="managed-launch-title"><header className="sheet__header"><div><p className="eyebrow">启动任务</p><h2 id="managed-launch-title">确认项目、算力与命令</h2></div><button className="icon-button" onClick={() => setLaunchOpen(false)} disabled={launching} aria-label="关闭"><X size={18} /></button></header><div className="managed-launch-body"><aside><strong>启动配置</strong>{profiles.map((profile) => <button className={profile.id === launchProfile.id ? 'is-selected' : ''} key={profile.id} onClick={() => { setLaunchProfile({ ...profile }); setSelectedServerId(''); setLaunchError(null) }}><span>{profile.name}</span><small>{projects.find((item) => item.id === profile.projectId)?.name ?? '未关联项目'}</small></button>)}<button className={!profiles.some((profile) => profile.id === launchProfile.id) ? 'is-selected' : ''} onClick={() => setLaunchProfile(defaultProfile(projects))}><span>临时任务</span><small>可选择保存配置</small></button></aside><div className="managed-launch-form"><section><header><span>1</span><div><strong>任务与命令</strong><small>明确保存工作目录，避免从进程参数反推。</small></div></header><div className="managed-launch-fields"><label>配置名称<input value={launchProfile.name} onChange={(event) => updateLaunchProfile({ name: event.target.value })} /></label><label>关联项目<select value={launchProfile.projectId ?? ''} onChange={(event) => { const project = projects.find((item) => item.id === event.target.value); updateLaunchProfile({ projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? launchProfile.workingDirectory, datasetIds: project?.datasetIds ?? [] }); setSelectedServerId('') }}><option value="">不关联项目</option>{projects.filter((project) => project.kind === 'project').map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label className="is-wide">工作目录<input value={selectedProject ? selectedProjectPath || '所选服务器尚未配置项目副本' : launchProfile.workingDirectory} disabled={Boolean(selectedProject)} onChange={(event) => updateLaunchProfile({ workingDirectory: event.target.value })} /></label><label className="is-wide">启动命令<textarea rows={2} value={launchProfile.command} onChange={(event) => updateLaunchProfile({ command: event.target.value })} /></label></div></section><section><header><span>2</span><div><strong>运行位置</strong><small>自动推荐按空闲显存排序，也可以指定具体 GPU。</small></div></header><div className="managed-launch-server-list">{servers.filter((server) => snapshots[server.id]).map((server) => { const projectPath = selectedProject ? projectPathOnServer(selectedProject, server.id) : launchProfile.workingDirectory; return <button className={server.id === selectedServerId ? 'is-selected' : ''} key={server.id} onClick={() => { setSelectedServerId(server.id); setSelectedGpuUuids([]); setLaunchError(null) }}><span><i className={`server-row__status server-row__status--${server.status}`} /><strong>{server.name}</strong></span><small>{snapshots[server.id]?.gpus.length ?? 0} 张 GPU · {selectedProject ? projectPath ? '项目已配置' : '缺少项目副本' : '可运行临时任务'}</small></button>})}</div><div className="managed-assignment-mode"><button className={assignmentMode === 'automatic' ? 'is-selected' : ''} onClick={() => setAssignmentMode('automatic')}>自动推荐</button><button className={assignmentMode === 'manual' ? 'is-selected' : ''} onClick={() => setAssignmentMode('manual')}>指定 GPU</button></div><div className="managed-gpu-list">{availableGpus.map((gpu, index) => { const selected = selectedGpuUuids.includes(gpu.uuid); return <label className={selected ? 'is-selected' : ''} key={gpu.uuid}><input type="checkbox" checked={selected} disabled={assignmentMode === 'automatic'} onChange={(event) => setSelectedGpuUuids((current) => event.target.checked ? [...current, gpu.uuid] : current.filter((uuid) => uuid !== gpu.uuid))} /><span><strong>GPU {gpu.index}</strong><small>{gpu.name.replace(/^NVIDIA\s+/i, '')} · 空闲 {((gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} GB</small></span>{assignmentMode === 'automatic' && index < launchProfile.gpuCount && <em>推荐</em>}</label>})}{selectedServerId && availableGpus.length === 0 && <p>没有满足当前型号和显存要求的 GPU。</p>}</div><div className="managed-resource-fields"><label>GPU 数量<input type="number" min="0" max="16" value={launchProfile.gpuCount} onChange={(event) => updateLaunchProfile({ gpuCount: Math.max(0, Number(event.target.value) || 0) })} /></label><label>GPU 型号<input placeholder="不限" value={launchProfile.gpuModel ?? ''} onChange={(event) => updateLaunchProfile({ gpuModel: event.target.value || null })} /></label><label>每卡最低空闲显存<input type="number" min="0" value={launchProfile.minimumGpuMemoryGb} onChange={(event) => updateLaunchProfile({ minimumGpuMemoryGb: Math.max(0, Number(event.target.value) || 0) })} /></label></div></section><section><header><span>3</span><div><strong>启动前检查</strong><small>项目和数据集只在确实缺少副本时同步。</small></div></header><div className="managed-preflight"><div><CheckCircle2 size={15} /><span><strong>{selectedProject?.name ?? '临时命令'}</strong><small>{selectedProject ? selectedProjectPath || '所选服务器没有项目副本' : launchProfile.workingDirectory}</small></span></div>{selectedProject?.datasetIds.map((id) => { const dataset = projects.find((item) => item.id === id); const path = dataset && selectedServerId ? projectPathOnServer(dataset, selectedServerId) : ''; return dataset ? <div key={id}><Database size={15} /><span><strong>{dataset.name}</strong><small>{path || '所选服务器尚未配置数据集副本'}</small></span></div> : null })}<label><input type="checkbox" checked={syncDependencies} onChange={(event) => setSyncDependencies(event.target.checked)} /><span><strong>启动前补齐待更新副本</strong><small>遇到冲突时停止启动，不覆盖远端修改。</small></span></label></div><div className="managed-command-preview"><code>{selectedProjectPath || launchProfile.workingDirectory}<br /><span>CUDA_VISIBLE_DEVICES={selectedGpuUuids.map((uuid) => selectedSnapshot?.gpus.find((gpu) => gpu.uuid === uuid)?.index).filter((value) => value != null).join(',')}</span> {launchProfile.command}</code></div><label className="managed-save-profile"><input type="checkbox" checked={saveProfile} onChange={(event) => setSaveProfile(event.target.checked)} />保存为启动配置</label>{launchError && <p className="form-error" role="alert">{launchError}</p>}</section></div></div><footer className="sheet__footer"><span className="managed-launch-readiness">{selectedGpuUuids.length === launchProfile.gpuCount && (selectedProjectPath || launchProfile.workingDirectory) ? <><CheckCircle2 size={13} />配置完整，可以启动</> : <><AlertCircle size={13} />请完成运行位置与资源选择</>}</span><button className="button button--secondary" onClick={() => setLaunchOpen(false)} disabled={launching}>取消</button><button className="button button--primary" onClick={() => void launch()} disabled={launching}>{launching ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{launching ? '正在准备…' : '启动任务'}</button></footer></section></div>}

    {logRun && <aside className="managed-log-inspector"><header><div><p className="eyebrow">实时日志</p><h2>{logRun.name}</h2></div><button className="icon-button" onClick={() => setLogRun(null)} aria-label="关闭"><X size={16} /></button></header><div className="managed-log-meta"><span>{servers.find((server) => server.id === logRun.serverId)?.name ?? '服务器已移除'}</span><span>{logRun.gpuIndices.length ? `GPU ${logRun.gpuIndices.join(', ')}` : 'CPU'}</span></div><pre>{loadingLog ? '正在读取远端日志…' : logContent || '日志暂时为空。'}</pre><footer><button className="button button--secondary" onClick={() => void openLog(logRun)}><RefreshCw size={13} />刷新日志</button><button className="button button--primary" onClick={() => onOpenTerminal(logRun.serverId)}><TerminalSquare size={13} />打开终端</button></footer></aside>}

    {pendingStop && <div className="scrim"><section className="sheet managed-stop-sheet" role="alertdialog" aria-modal="true"><header><span><Square size={15} fill="currentColor" /></span><div><p className="eyebrow">结束远程任务</p><h2>确认结束“{pendingStop.name}”？</h2></div></header><p>将结束任务根 PID {pendingStop.pid} 及其子进程。未保存的训练状态可能丢失。</p><footer><button className="button button--secondary" onClick={() => setPendingStop(null)} disabled={stopping}>取消</button><button className="button button--danger" onClick={() => void stopRun()} disabled={stopping}>{stopping ? <LoaderCircle className="spin" size={14} /> : <Square size={12} fill="currentColor" />}结束任务</button></footer></section></div>}
  </div>
}
