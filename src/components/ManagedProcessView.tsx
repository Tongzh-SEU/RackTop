import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Box, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Database, FolderGit2, LoaderCircle, MoreHorizontal, Play, Plus, RefreshCw, RotateCcw, Save, ScrollText, Server as ServerIcon, SlidersHorizontal, Square, TerminalSquare, Trash2, X } from 'lucide-react'
import { api } from '../services/api'
import type { LaunchProfile, ManagedRun, ManagedRunRemoteStatus, Project, Server, Snapshot } from '../types/models'
import { hasOtherUserGpuWorkload } from '../utils/gpu'
import { currentUserProcessCount } from '../utils/processRelations'
import { loadLaunchProfiles, loadManagedRuns, processBelongsToManagedRun, projectPathOnServer, projectWorkingDirectory, runIsObserved, runProcesses, saveLaunchProfiles, saveManagedRuns } from '../utils/managedRuns'
import type { MineProcessWarning } from '../utils/mineProcessWarnings'
import { elapsedSeconds, isGpuProcess, unmanagedProcessGroups } from '../utils/unmanagedProcessGroups'
import type { UnmanagedProcessGroup } from '../utils/unmanagedProcessGroups'
import { normalizeLaunchCommand, parseTaskParameters, replaceLaunchContext, resolveProjectLogPath, updateLaunchParameter } from '../utils/launchCommand'
import { acceleratorLabel } from '../utils/accelerator'

type ViewTab = 'running' | 'profiles' | 'recent'

export function managedRunAfterRemoteStatus(run: ManagedRun, status: ManagedRunRemoteStatus, now = Math.floor(Date.now() / 1_000)): ManagedRun {
  if (status.status === 'running') return run.status === 'running' ? run : { ...run, status: 'running' }
  if (status.status === 'exited') {
    const nextStatus = status.exitCode === 0 ? 'completed' : 'failed'
    if (run.status === nextStatus && run.exitCode === status.exitCode && run.endedAt) return run
    return { ...run, status: nextStatus, exitCode: status.exitCode, endedAt: now }
  }
  return { ...run, status: 'failed', endedAt: now }
}

export function launchDependencyIssue(project: Project, projects: Project[], serverId: string) {
  for (const [kind, ids] of [['dataset', project.datasetIds], ['model', project.modelIds]] as const) {
    for (const id of ids) {
      const resource = projects.find((item) => item.id === id && item.kind === kind)
      const label = kind === 'dataset' ? '数据集' : '模型'
      if (!resource) return `关联${label}已移除，请先更新项目配置。`
      if (resource.sourceServerId !== serverId && !resource.targets.some((target) => target.serverId === serverId)) {
        return `关联${label}“${resource.name}”尚未配置到所选服务器，请先在“我的项目”中补齐目标路径。`
      }
    }
  }
  return null
}

export type ManagedLaunchIntent = {
  id: string
  projectId?: string
  serverId?: string
  gpuUuid?: string
}

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

function formatMemoryBytes(value: number) {
  return `${(Math.max(0, value) / 1024 ** 3).toFixed(1)} GB`
}

function formatTimestamp(timestamp?: number | null) {
  if (!timestamp) return '尚未运行'
  return new Date(timestamp * 1_000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

function defaultProfile(projects: Project[], preferredProjectId?: string | null): LaunchProfile {
  const project = preferredProjectId === null ? undefined : projects.find((item) => item.id === preferredProjectId && item.kind === 'project') ?? projects.find((item) => item.kind === 'project')
  const now = Math.floor(Date.now() / 1_000)
  const filename = project?.sourceIsDirectory === false ? project.sourcePath.split('/').pop() : null
  return { id: crypto.randomUUID(), name: project?.name ? `${project.name} 运行` : '新启动配置', projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? '~/projects', command: filename?.endsWith('.py') ? `python ${filename}` : 'python train.py', gpuCount: 1, gpuModel: null, minimumGpuMemoryGb: 0, datasetIds: project?.datasetIds ?? [], createdAt: now, updatedAt: now }
}

function demoProfiles(projects: Project[]) {
  const now = Math.floor(Date.now() / 1_000)
  const project = projects.find((item) => item.id === 'demo-project-training') ?? projects.find((item) => item.kind === 'project')
  return [
    { id: 'demo-profile-train', name: 'Llama-3 微调', projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? '~/projects/llama-finetune', command: 'python train.py --config a100.yaml', gpuCount: 2, gpuModel: 'A100', minimumGpuMemoryGb: 60, datasetIds: project?.datasetIds ?? [], createdAt: now, updatedAt: now },
    { id: 'demo-profile-eval', name: '模型评估', projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? '~/projects/model-eval', command: 'python evaluate.py', gpuCount: 1, gpuModel: null, minimumGpuMemoryGb: 20, datasetIds: [], createdAt: now, updatedAt: now },
  ] satisfies LaunchProfile[]
}

function demoRuns(projects: Project[]) {
  const project = projects.find((item) => item.id === 'demo-project-training')
  const startedAt = Math.floor(Date.now() / 1_000) - (1 * 3_600 + 42 * 60 + 18)
  return [{
    id: 'demo-run-llama-train',
    profileId: null,
    name: 'Llama-3 8B 微调',
    projectId: project?.id ?? null,
    serverId: 'demo-233',
    gpuUuids: ['GPU-9e1c'],
    gpuIndices: [0],
    workingDirectory: '~/projects/llama-finetune',
    command: 'python train.py --config configs/llama3-8b.yaml --devices 0',
    pid: 42861,
    logPath: '~/.racktop/runs/demo-run-llama-train/output.log',
    startedAt,
    status: 'running',
  }] satisfies ManagedRun[]
}

function currentUserSnapshot(snapshot: Snapshot, runs: ManagedRun[]) {
  return {
    ...snapshot,
    processes: snapshot.processes.filter((process) => process.isCurrentUser && !processBelongsToManagedRun(snapshot.serverId, process, runs)),
    cpuProcesses: snapshot.cpuProcesses.filter((process) => process.isCurrentUser && !processBelongsToManagedRun(snapshot.serverId, process, runs)),
  }
}

export function ManagedProcessView({ servers, snapshots, projects, warnings, launchIntent, initialTab = 'running', onLaunchIntentConsumed, onDismissWarning, onOpenTerminal, onNotice, onRefreshServer, onExpectedProcessExit }: {
  servers: Server[]
  snapshots: Record<string, Snapshot>
  projects: Project[]
  warnings: MineProcessWarning[]
  launchIntent?: ManagedLaunchIntent | null
  initialTab?: ViewTab
  onLaunchIntentConsumed?: () => void
  onDismissWarning: (warningId: string) => void
  onOpenTerminal: (serverId: string) => void
  onNotice: (message: string) => void
  onRefreshServer: (serverId: string) => Promise<void>
  onExpectedProcessExit?: (serverId: string, pid: number, expected: boolean) => void
}) {
  const [tab, setTab] = useState<ViewTab>(initialTab)
  const [profiles, setProfiles] = useState<LaunchProfile[]>(() => loadLaunchProfiles())
  const [profileProjectId, setProfileProjectId] = useState<string | null>(() => {
    const projectIds = new Set(projects.filter((project) => project.kind === 'project').map((project) => project.id))
    return loadLaunchProfiles().find((profile) => profile.projectId && projectIds.has(profile.projectId))?.projectId ?? projects.find((project) => project.kind === 'project')?.id ?? null
  })
  const [runs, setRuns] = useState<ManagedRun[]>(() => {
    const stored = loadManagedRuns()
    return !api.isDesktop && stored.length === 0 ? demoRuns(projects) : stored
  })
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [expandedUnmanaged, setExpandedUnmanaged] = useState<Set<string>>(new Set())
  const [unmanagedOpen, setUnmanagedOpen] = useState(false)
  const [launchOpen, setLaunchOpen] = useState(false)
  const [launchProfile, setLaunchProfile] = useState<LaunchProfile>(() => defaultProfile(projects))
  const [launchProjectContextId, setLaunchProjectContextId] = useState<string | null>(null)
  const [selectedServerId, setSelectedServerId] = useState('')
  const [assignmentMode, setAssignmentMode] = useState<'automatic' | 'manual'>('automatic')
  const [selectedGpuUuids, setSelectedGpuUuids] = useState<string[]>([])
  const [excludeOccupiedGpus, setExcludeOccupiedGpus] = useState(true)
  const [requestedGpuIndices, setRequestedGpuIndices] = useState<number[] | null>(null)
  const [saveProfile, setSaveProfile] = useState(true)
  const [syncDependencies, setSyncDependencies] = useState(true)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [parametersOpen, setParametersOpen] = useState(false)
  const [collapsedProfileGroups, setCollapsedProfileGroups] = useState<Set<string>>(new Set())
  const [logRun, setLogRun] = useState<ManagedRun | null>(null)
  const [logContent, setLogContent] = useState('')
  const [loadingLog, setLoadingLog] = useState(false)
  const [pendingStop, setPendingStop] = useState<ManagedRun | null>(null)
  const [pendingUnmanagedStop, setPendingUnmanagedStop] = useState<{ server: Server; group: UnmanagedProcessGroup } | null>(null)
  const [pendingAssociation, setPendingAssociation] = useState<{ server: Server; group: UnmanagedProcessGroup } | null>(null)
  const [associationProjectId, setAssociationProjectId] = useState('')
  const [stoppingRunIds, setStoppingRunIds] = useState<Set<string>>(new Set())
  const [stoppingUnmanagedKeys, setStoppingUnmanagedKeys] = useState<Set<string>>(new Set())

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
    if (api.isDesktop || runs.length > 0) return
    setRuns(demoRuns(projects))
  }, [projects, runs.length])

  useEffect(() => {
    if (!launchIntent) return
    const fromProject = Boolean(launchIntent.projectId)
    const profile = fromProject ? profiles.find((item) => item.projectId === launchIntent.projectId) ?? defaultProfile(projects, launchIntent.projectId) : defaultProfile(projects, null)
    if (!fromProject) profile.name = '临时任务'
    if (launchIntent.gpuUuid) profile.gpuCount = 1
    openLaunch(profile, launchIntent, launchIntent.projectId ?? null)
    onLaunchIntentConsumed?.()
  }, [launchIntent?.id, profiles, projects])

  useEffect(() => {
    const active = runs.filter((run) => ['starting', 'running', 'unknown'].includes(run.status) && !runIsObserved(run, snapshots[run.serverId]) && Date.now() / 1_000 - run.startedAt > 2)
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
          const updated = managedRunAfterRemoteStatus(run, status)
          if (updated !== run) changed = true
          return updated
        })
        return changed ? next : current
      })
    }
    void check()
    const interval = window.setInterval(check, 5_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [runs, snapshots])

  const activeRuns = runs.filter((run) => ['starting', 'running', 'unknown'].includes(run.status))
  const recentRuns = runs.filter((run) => !['starting', 'running', 'unknown'].includes(run.status)).sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))
  const activeServerIds = new Set(activeRuns.map((run) => run.serverId))
  const unmanagedServers = servers.flatMap((server) => {
    const snapshot = snapshots[server.id]
    if (!snapshot) return []
    const unmanaged = currentUserSnapshot(snapshot, activeRuns)
    const groups = unmanagedProcessGroups(unmanaged)
    return groups.length > 0 ? [{ server, snapshot: unmanaged, groups }] : []
  })

  const selectedServer = servers.find((server) => server.id === selectedServerId)
  const selectedSnapshot = selectedServerId ? snapshots[selectedServerId] : undefined
  const selectedAccelerator = selectedSnapshot ? acceleratorLabel(selectedSnapshot) : 'GPU'
  const selectedProject = projects.find((project) => project.id === launchProfile.projectId)
  const selectedProjectPath = selectedProject && selectedServerId ? projectWorkingDirectory(selectedProject, selectedServerId) : launchProfile.workingDirectory
  const launchServers = useMemo(() => servers.filter((server) => snapshots[server.id] && (!selectedProject || Boolean(projectPathOnServer(selectedProject, server.id)))), [selectedProject, servers, snapshots])
  const availableGpus = useMemo(() => {
    if (!selectedSnapshot) return []
    return selectedSnapshot.gpus.filter((gpu) => gpu.memoryTotalMb > 0 && (gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024 >= launchProfile.minimumGpuMemoryGb && (!excludeOccupiedGpus || !hasOtherUserGpuWorkload(gpu, selectedSnapshot.processes))).sort((left, right) => (right.memoryTotalMb - right.memoryUsedMb) - (left.memoryTotalMb - left.memoryUsedMb))
  }, [excludeOccupiedGpus, launchProfile.minimumGpuMemoryGb, selectedSnapshot])
  const launchParameters = useMemo(() => parseTaskParameters(launchProfile.command), [launchProfile.command])
  const selectedGpuIndices = useMemo(() => selectedGpuUuids.map((uuid) => selectedSnapshot?.gpus.find((gpu) => gpu.uuid === uuid)?.index).filter((index): index is number => index != null), [selectedGpuUuids, selectedSnapshot])
  const profileGroups = useMemo(() => {
    const projectGroups = projects
      .filter((project) => project.kind === 'project')
      .map((project) => ({ id: `project:${project.id}`, name: project.name, profiles: profiles.filter((profile) => profile.projectId === project.id) }))
      .filter((group) => group.profiles.length > 0)
    const associated = new Set(projects.filter((project) => project.kind === 'project').map((project) => project.id))
    const unassociated = profiles.filter((profile) => !profile.projectId || !associated.has(profile.projectId))
    return unassociated.length ? [...projectGroups, { id: 'unassociated', name: '未关联项目', profiles: unassociated }] : projectGroups
  }, [profiles, projects])
  const visibleProfileGroups = useMemo(() => launchProjectContextId ? profileGroups.filter((group) => group.id === `project:${launchProjectContextId}`) : profileGroups, [launchProjectContextId, profileGroups])
  const profileProjects = useMemo(() => projects.filter((project) => project.kind === 'project'), [projects])
  const selectedProfileProject = profileProjects.find((project) => project.id === profileProjectId)
  const selectedProjectProfiles = useMemo(() => profiles
    .filter((profile) => selectedProfileProject ? profile.projectId === selectedProfileProject.id : !profile.projectId || !profileProjects.some((project) => project.id === profile.projectId))
    .sort((left, right) => {
      const latestLeft = runs.filter((run) => run.profileId === left.id).sort((a, b) => b.startedAt - a.startedAt)[0]?.startedAt ?? 0
      const latestRight = runs.filter((run) => run.profileId === right.id).sort((a, b) => b.startedAt - a.startedAt)[0]?.startedAt ?? 0
      return latestRight - latestLeft || right.updatedAt - left.updatedAt
    }), [profileProjects, profiles, runs, selectedProfileProject])

  useEffect(() => {
    if (profileProjectId && profileProjects.some((project) => project.id === profileProjectId)) return
    if (profileProjectId === null && profiles.some((profile) => !profile.projectId)) return
    setProfileProjectId(profileProjects[0]?.id ?? null)
  }, [profileProjectId, profileProjects, profiles])

  useEffect(() => {
    if (!launchOpen) return
    if (!selectedServerId || !launchServers.some((server) => server.id === selectedServerId)) setSelectedServerId(launchServers[0]?.id ?? '')
  }, [launchOpen, launchServers, selectedServerId])

  useEffect(() => {
    if (!launchOpen || assignmentMode !== 'automatic') return
    setSelectedGpuUuids(availableGpus.slice(0, launchProfile.gpuCount).map((gpu) => gpu.uuid))
  }, [assignmentMode, availableGpus, launchOpen, launchProfile.gpuCount])

  useEffect(() => {
    if (!launchOpen || !requestedGpuIndices || !selectedSnapshot) return
    const requestedGpus = requestedGpuIndices.map((index) => selectedSnapshot.gpus.find((gpu) => gpu.index === index)).filter(Boolean) as Snapshot['gpus']
    if (requestedGpus.length !== requestedGpuIndices.length) return
    setAssignmentMode('manual')
    setSelectedGpuUuids(requestedGpus.map((gpu) => gpu.uuid))
    setRequestedGpuIndices(null)
  }, [launchOpen, requestedGpuIndices, selectedSnapshot])

  function openLaunch(profile?: LaunchProfile, intent?: ManagedLaunchIntent, projectContextId: string | null = null) {
    setLaunchProfile(profile ? { ...profile } : defaultProfile(projects))
    setLaunchProjectContextId(projectContextId)
    setSelectedServerId(intent?.serverId ?? '')
    setAssignmentMode(intent?.gpuUuid ? 'manual' : 'automatic')
    setSelectedGpuUuids(intent?.gpuUuid ? [intent.gpuUuid] : [])
    setExcludeOccupiedGpus(true)
    setRequestedGpuIndices(null)
    setSaveProfile(Boolean(profile) || profiles.length === 0)
    setSyncDependencies(true)
    setParametersOpen(false)
    setLaunchError(null)
    setLaunchOpen(true)
  }

  function updateLaunchProfile(patch: Partial<LaunchProfile>) {
    if (typeof patch.command !== 'string') {
      setLaunchProfile((current) => ({ ...current, ...patch, updatedAt: Math.floor(Date.now() / 1_000) }))
      return
    }
    const pastedCommand = patch.command
    const normalized = normalizeLaunchCommand(pastedCommand)
    if (normalized.detectedCudaVisibleDevices) {
      setRequestedGpuIndices(normalized.detectedCudaVisibleDevices)
      setAssignmentMode('manual')
      setSelectedGpuUuids([])
    }
    setLaunchProfile((current) => ({
      ...current,
      ...patch,
      command: pastedCommand,
      workingDirectory: !current.projectId && normalized.detectedWorkingDirectory ? normalized.detectedWorkingDirectory : current.workingDirectory,
      gpuCount: normalized.detectedCudaVisibleDevices?.length ?? current.gpuCount,
      projectLogPath: normalized.detectedProjectLogPath ?? current.projectLogPath ?? null,
      updatedAt: Math.floor(Date.now() / 1_000),
    }))
  }

  function saveLaunchProfile() {
    const normalizedCommand = normalizeLaunchCommand(launchProfile.command).command
    if (!launchProfile.name.trim()) { setLaunchError('请填写配置名称。'); return }
    if (!normalizedCommand) { setLaunchError('请保留实际执行命令后再添加配置。'); return }
    const profile = { ...launchProfile, updatedAt: Math.floor(Date.now() / 1_000) }
    const exists = profiles.some((item) => item.id === profile.id)
    setProfiles((current) => exists ? current.map((item) => item.id === profile.id ? profile : item) : [profile, ...current])
    setLaunchProfile(profile)
    setSaveProfile(true)
    setLaunchError(null)
    setLaunchOpen(false)
    onNotice(exists ? `已保存“${profile.name}”` : `已添加“${profile.name}”到启动配置`)
  }

  async function launch(profile = launchProfile) {
    const server = servers.find((item) => item.id === selectedServerId)
    if (!server || !selectedSnapshot) { setLaunchError('请选择已连接的服务器。'); return }
    const gpuUuids = launchProfile.gpuCount > 0 ? selectedGpuUuids : []
    if (gpuUuids.length !== launchProfile.gpuCount) { setLaunchError(`当前配置需要 ${launchProfile.gpuCount} 张 ${selectedAccelerator}。`); return }
    const gpus = gpuUuids.map((uuid) => selectedSnapshot.gpus.find((gpu) => gpu.uuid === uuid)).filter(Boolean) as Snapshot['gpus']
    const workingDirectory = selectedProject ? selectedProjectPath : profile.workingDirectory
    if (!workingDirectory) { setLaunchError('所选服务器上没有项目副本，请先在“我的项目”中配置同步目标。'); return }
    const normalizedCommand = normalizeLaunchCommand(profile.command)
    if (!normalizedCommand.command) { setLaunchError(`启动命令在移除目录、${selectedAccelerator} 和后台包装后为空。请保留实际执行命令。`); return }
    const preparedProfile = { ...profile, command: normalizedCommand.command }
    if (selectedProject) {
      const dependencyIssue = launchDependencyIssue(selectedProject, projects, server.id)
      if (dependencyIssue) { setLaunchError(dependencyIssue); return }
    }
    setLaunching(true)
    setLaunchError(null)
    try {
      if (syncDependencies && selectedProject && selectedProject.sourceServerId !== server.id) {
        const target = selectedProject.targets.find((item) => item.serverId === server.id)
        if (target && target.status !== 'synced') await api.syncProject(selectedProject.id, server.id)
        for (const resourceId of [...selectedProject.datasetIds, ...selectedProject.modelIds]) {
          const resource = projects.find((item) => item.id === resourceId)
          const resourceTarget = resource?.targets.find((item) => item.serverId === server.id)
          if (resource && resource.sourceServerId !== server.id && resourceTarget && resourceTarget.status !== 'synced') await api.syncProject(resource.id, server.id)
        }
      }
      const runId = crypto.randomUUID()
      const projectLogPath = profile.projectLogPath ? resolveProjectLogPath(profile.projectLogPath, profile.command) : null
      const result = await api.launchManagedRun(server.id, runId, workingDirectory, preparedProfile.command, gpus.map((gpu) => gpu.index), projectLogPath, selectedSnapshot.acceleratorVendor)
      const run: ManagedRun = { id: runId, profileId: saveProfile ? profile.id : null, name: profile.name.trim() || '临时任务', projectId: profile.projectId, serverId: server.id, gpuUuids, gpuIndices: gpus.map((gpu) => gpu.index), workingDirectory, command: preparedProfile.command, pid: result.pid, logPath: result.logPath, startedAt: Math.floor(Date.now() / 1_000), status: 'starting' }
      setRuns((current) => [run, ...current])
      if (saveProfile) setProfiles((current) => [{ ...profile, updatedAt: Math.floor(Date.now() / 1_000) }, ...current.filter((item) => item.id !== profile.id)])
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
    const target = pendingStop
    setPendingStop(null)
    setStoppingRunIds((current) => new Set(current).add(target.id))
    onExpectedProcessExit?.(target.serverId, target.pid, true)
    try {
      await api.terminateProcess(target.serverId, target.pid)
      setRuns((current) => current.map((run) => run.id === target.id ? { ...run, status: 'stopped', endedAt: Math.floor(Date.now() / 1_000) } : run))
      onNotice(`已结束“${target.name}”`)
      await onRefreshServer(target.serverId)
    } catch (reason) {
      onExpectedProcessExit?.(target.serverId, target.pid, false)
      onNotice(`结束任务失败：${String(reason).replace(/^Error:\s*/, '')}`)
    } finally {
      setStoppingRunIds((current) => { const next = new Set(current); next.delete(target.id); return next })
    }
  }

  function openAssociation(server: Server, group: UnmanagedProcessGroup) {
    setPendingAssociation({ server, group })
    setAssociationProjectId(projects.find((project) => project.kind === 'project')?.id ?? '')
  }

  function associateProcess() {
    if (!pendingAssociation || !associationProjectId) return
    const project = projects.find((item) => item.id === associationProjectId)
    if (!project) return
    const { server, group } = pendingAssociation
    const now = Math.floor(Date.now() / 1_000)
    const run: ManagedRun = {
      id: crypto.randomUUID(),
      profileId: null,
      name: group.root.command,
      projectId: project.id,
      serverId: server.id,
      gpuUuids: group.gpuUuids,
      gpuIndices: group.gpuIndices,
      workingDirectory: projectWorkingDirectory(project, server.id) || '未获取',
      command: group.root.command,
      pid: group.rootPid,
      logPath: '未获取',
      startedAt: now - elapsedSeconds(group.elapsed),
      status: 'running',
    }
    setRuns((current) => [run, ...current])
    setExpandedRuns((current) => new Set(current).add(run.id))
    setPendingAssociation(null)
    onNotice(`已将 PID ${group.rootPid} 关联到项目“${project.name}”`)
  }

  function saveUnmanagedProfile(group: UnmanagedProcessGroup) {
    const now = Math.floor(Date.now() / 1_000)
    const profile: LaunchProfile = {
      id: crypto.randomUUID(),
      name: group.root.command,
      projectId: null,
      workingDirectory: '',
      command: group.root.command,
      gpuCount: group.gpuIndices.length,
      gpuModel: null,
      minimumGpuMemoryGb: 0,
      datasetIds: [],
      createdAt: now,
      updatedAt: now,
    }
    setProfiles((current) => [profile, ...current])
    onNotice(`已保存 PID ${group.rootPid} 的启动配置`)
  }

  async function stopUnmanagedProcess() {
    if (!pendingUnmanagedStop) return
    const { server, group } = pendingUnmanagedStop
    const key = `${server.id}:${group.rootPid}`
    setPendingUnmanagedStop(null)
    setStoppingUnmanagedKeys((current) => new Set(current).add(key))
    onExpectedProcessExit?.(server.id, group.rootPid, true)
    try {
      await api.terminateProcess(server.id, group.rootPid)
      onNotice(`已结束未关联进程 PID ${group.rootPid}`)
      await onRefreshServer(server.id)
    } catch (reason) {
      onExpectedProcessExit?.(server.id, group.rootPid, false)
      onNotice(`结束进程失败：${String(reason).replace(/^Error:\s*/, '')}`)
    } finally {
      setStoppingUnmanagedKeys((current) => { const next = new Set(current); next.delete(key); return next })
    }
  }

  return <div className="detail-page managed-process-page">
    <div className="managed-process-toolbar">
      <div className="managed-process-tabs" role="tablist">
        <button className={tab === 'running' ? 'is-active' : ''} role="tab" aria-selected={tab === 'running'} onClick={() => setTab('running')}>运行中 <span>{activeRuns.length}</span></button>
        <button className={tab === 'profiles' ? 'is-active' : ''} role="tab" aria-selected={tab === 'profiles'} onClick={() => setTab('profiles')}>启动配置 <span>{profiles.length}</span></button>
        <button className={tab === 'recent' ? 'is-active' : ''} role="tab" aria-selected={tab === 'recent'} onClick={() => setTab('recent')}>最近结束 <span>{recentRuns.length}</span></button>
      </div>
      {activeRuns.length > 0 && <button className="button button--primary managed-process-launch" onClick={() => openLaunch()}><Play size={15} />启动任务</button>}
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
            const terminating = stoppingRunIds.has(run.id)
            return <article className={`managed-run-row ${expanded ? 'is-expanded' : ''}${terminating ? ' is-terminating' : ''}`} key={run.id} aria-busy={terminating}>
              <button className="managed-run-disclosure" onClick={() => setExpandedRuns((current) => { const next = new Set(current); if (next.has(run.id)) next.delete(run.id); else next.add(run.id); return next })} aria-label={expanded ? '收起任务' : '展开任务'}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
              <div className="managed-run-identity"><div><CircleDot size={13} /><strong>{run.name}</strong>{terminating ? <span className="managed-run-terminating" role="status"><LoaderCircle className="spin" size={11} />正在结束</span> : run.projectId && <span>项目任务</span>}</div><p>{profiles.find((profile) => profile.id === run.profileId)?.name ?? '临时任务'} · <code>{run.command}</code></p></div>
              <div className="managed-run-placement"><strong>{run.gpuIndices.length ? `GPU ${run.gpuIndices.join(', ')}` : 'CPU'}</strong><small>{run.gpuIndices.length ? `${run.gpuIndices.length} 张 GPU` : '未使用 GPU'}</small></div>
              <dl className="managed-run-metrics">{run.gpuIndices.length ? <><div><dt>UTL</dt><dd>{utilization.toFixed(0)}%</dd></div><div><dt>MEM</dt><dd>{formatMemoryMb(memoryMb)}</dd></div><div><dt>SM</dt><dd>{sm.toFixed(0)}%</dd></div></> : <><div><dt>CPU</dt><dd>{observed.reduce((sum, process) => sum + process.cpuPercent, 0).toFixed(0)}%</dd></div><div><dt>内存</dt><dd>{formatMemoryMb(observed.reduce((sum, process) => sum + ('memoryUsedBytes' in process ? process.memoryUsedBytes / 1024 ** 2 : 0), 0))}</dd></div><div><dt>进程</dt><dd>{observed.length}</dd></div></>}<div><dt>运行</dt><dd>{relativeDuration(run.startedAt)}</dd></div></dl>
              <div className="managed-run-actions"><button className="icon-button" title="打开终端" disabled={terminating} onClick={() => onOpenTerminal(server.id)}><TerminalSquare size={14} /></button><button className="icon-button" title="查看日志" disabled={terminating} onClick={() => void openLog(run)}><ScrollText size={14} /></button><button className="icon-button" title="重新启动" disabled={terminating} onClick={() => void restartRun(run)}><RotateCcw size={14} /></button><button className="icon-button is-danger" title={terminating ? '正在结束' : '结束任务'} disabled={terminating} onClick={() => setPendingStop(run)}>{terminating ? <LoaderCircle className="spin" size={13} /> : <Square size={12} fill="currentColor" />}</button><button className="icon-button" title="更多操作" disabled={terminating}><MoreHorizontal size={15} /></button></div>
              {expanded && <div className="managed-run-details"><dl><div><dt>工作目录</dt><dd><code>{run.workingDirectory}</code></dd></div><div><dt>任务根 PID</dt><dd><code>{run.pid}</code></dd></div><div><dt>日志</dt><dd><code>{run.logPath}</code></dd></div><div><dt>状态</dt><dd>{run.status === 'starting' ? '正在确认进程' : run.status === 'unknown' ? '等待远端确认' : '运行中'}</dd></div></dl>{observed.length > 0 ? <div className="managed-process-tree">{observed.map((process) => <div key={`${process.pid}-${'gpuUuid' in process ? process.gpuUuid : 'cpu'}`}><i /><code>PID {process.pid}</code><span>{process.command}</span><em>{'gpuIndex' in process ? `GPU ${process.gpuIndex}` : 'CPU'}</em></div>)}</div> : <p className="managed-run-waiting"><LoaderCircle className="spin" size={13} />等待下一次进程采样建立附属关系</p>}</div>}
            </article>
          })}</div>
        </section>
      })}
      {activeRuns.length === 0 && unmanagedServers.length === 0 && <div className="managed-process-empty"><CircleDot size={28} /><strong>没有由 RackTop 管理的任务</strong><p>启动任务后，这里会持续显示项目、GPU、进程关系和运行状态。</p><button className="button button--primary" onClick={() => openLaunch()}><Play size={14} />启动任务</button></div>}
      {unmanagedServers.length > 0 && <section className={`unmanaged-processes ${unmanagedOpen || activeRuns.length === 0 ? 'is-open' : ''}`}>
        <button onClick={() => setUnmanagedOpen((value) => !value)}><span><strong>未关联进程</strong><small>{unmanagedServers.reduce((sum, item) => sum + currentUserProcessCount(item.snapshot), 0)} 个由终端或其他工具启动的进程</small></span>{unmanagedOpen || activeRuns.length === 0 ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
        <div>{unmanagedServers.map(({ server, groups }) => <section key={server.id}>
          <header><ServerIcon size={14} /><strong>{server.name}</strong><small>{server.host} · {groups.length} 个进程组</small></header>
          <div className="managed-run-list unmanaged-run-list">{groups.map((group) => {
            const groupKey = `${server.id}:${group.rootPid}`
            const expanded = expandedUnmanaged.has(groupKey)
            const terminating = stoppingUnmanagedKeys.has(groupKey)
            return <article className={`managed-run-row unmanaged-run-row ${expanded ? 'is-expanded' : ''}${terminating ? ' is-terminating' : ''}`} key={groupKey} aria-busy={terminating}>
              <button className="managed-run-disclosure" onClick={() => setExpandedUnmanaged((current) => { const next = new Set(current); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next })} aria-label={expanded ? '收起进程组' : '展开进程组'}>{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
              <div className="managed-run-identity"><div><CircleDot size={13} /><strong title={group.root.command}>{group.root.command}</strong>{terminating ? <span className="managed-run-terminating" role="status"><LoaderCircle className="spin" size={11} />正在结束</span> : <span className="is-unmanaged">未关联</span>}</div><p>外部启动 · PID {group.rootPid} · {group.root.username}</p></div>
              <div className="managed-run-placement"><strong>{group.gpuIndices.length ? `GPU ${group.gpuIndices.join(', ')}` : 'CPU'}</strong><small>{group.gpuIndices.length ? `${group.gpuIndices.length} 张 GPU` : '未使用 GPU'}</small></div>
              <dl className="managed-run-metrics"><div><dt>显存</dt><dd>{group.gpuIndices.length ? formatMemoryMb(group.gpuMemoryMb) : '—'}</dd></div><div><dt>CPU</dt><dd>{group.cpuPercent.toFixed(1)}%</dd></div><div><dt>{group.gpuIndices.length ? '进程' : '内存'}</dt><dd>{group.gpuIndices.length ? group.processes.length : formatMemoryMb(group.systemMemoryMb)}</dd></div><div><dt>运行</dt><dd>{group.elapsed}</dd></div></dl>
              <div className="managed-run-actions unmanaged-run-actions"><button className="icon-button" title="关联项目" aria-label="关联项目" disabled={terminating || !projects.some((project) => project.kind === 'project')} onClick={() => openAssociation(server, group)}><FolderGit2 size={14} /></button><button className="icon-button" title="保存为启动配置" aria-label="保存为启动配置" disabled={terminating} onClick={() => saveUnmanagedProfile(group)}><Save size={14} /></button><button className="icon-button" title="打开终端" aria-label="打开终端" disabled={terminating} onClick={() => onOpenTerminal(server.id)}><TerminalSquare size={14} /></button><button className="icon-button is-danger" title={terminating ? '正在结束' : '结束进程'} aria-label={terminating ? '正在结束进程' : '结束进程'} disabled={terminating} onClick={() => setPendingUnmanagedStop({ server, group })}>{terminating ? <LoaderCircle className="spin" size={13} /> : <Square size={12} fill="currentColor" />}</button></div>
              {expanded && <div className="managed-run-details"><dl><div><dt>工作目录</dt><dd>未获取</dd></div><div><dt>根 PID</dt><dd><code>{group.rootPid}</code></dd></div><div><dt>日志</dt><dd>未获取</dd></div><div><dt>状态</dt><dd>未关联 · 运行中</dd></div></dl><div className="managed-process-tree">{group.processes.map((process) => <div key={`${process.pid}-${isGpuProcess(process) ? process.gpuUuid : 'cpu'}`}><i /><code>PID {process.pid}</code><span title={process.command}>{process.command}</span><em>{isGpuProcess(process) ? `GPU ${process.gpuIndex}` : 'CPU'}</em></div>)}</div></div>}
            </article>
          })}</div>
        </section>)}</div>
      </section>}
    </>}

    {tab === 'profiles' && <section className="managed-profile-view"><header><div><h2>项目启动配置</h2><p>按项目保存命令与超参数，运行时再选择服务器、项目副本和 GPU。</p></div></header><div className="managed-profile-workspace"><aside className="managed-profile-projects"><header><strong>项目</strong><span>{profileProjects.length}</span></header>{profileProjects.map((project) => { const count = profiles.filter((profile) => profile.projectId === project.id).length; return <button className={project.id === profileProjectId ? 'is-selected' : ''} key={project.id} onClick={() => setProfileProjectId(project.id)}><FolderGit2 size={14} /><span><strong>{project.name}</strong><small>{count} 个配置</small></span></button>})}{profiles.some((profile) => !profile.projectId || !profileProjects.some((project) => project.id === profile.projectId)) && <button className={profileProjectId === null ? 'is-selected' : ''} onClick={() => setProfileProjectId(null)}><SlidersHorizontal size={14} /><span><strong>未关联配置</strong><small>兼容已有模板</small></span></button>}</aside><div className="managed-profile-content"><header><div><strong>{selectedProfileProject?.name ?? '未关联配置'}</strong><small>{selectedProfileProject ? selectedProfileProject.sourcePath : '建议将这些配置关联到项目，以便跨服务器切换工作目录。'}</small></div><button className="button button--secondary" onClick={() => openLaunch(defaultProfile(projects, selectedProfileProject?.id ?? null), undefined, selectedProfileProject?.id ?? null)}><Plus size={14} />新建配置</button></header>{selectedProjectProfiles.length > 0 ? <div className="managed-profile-template-list">{selectedProjectProfiles.map((profile) => { const latest = runs.filter((run) => run.profileId === profile.id).sort((left, right) => right.startedAt - left.startedAt)[0]; const parameters = parseTaskParameters(profile.command); const normalized = normalizeLaunchCommand(profile.command).command; return <article className="managed-profile-template" key={profile.id}><header><div><strong>{profile.name}</strong><span>{parameters.length} 个超参数</span></div><div><button className="button button--secondary button--small" onClick={() => openLaunch(profile, undefined, profile.projectId ?? null)}><SlidersHorizontal size={12} />调整并运行</button><button className="icon-button" title="删除配置" aria-label={`删除配置 ${profile.name}`} onClick={() => setProfiles((current) => current.filter((item) => item.id !== profile.id))}><Trash2 size={13} /></button></div></header><code title={normalized}>{normalized}</code><div className="managed-profile-parameters">{parameters.slice(0, 4).map((parameter) => <span key={`${parameter.start}-${parameter.name}`}><code>{parameter.name}</code>{parameter.hasValue && <em>{parameter.value}</em>}</span>)}{parameters.length > 4 && <small>+{parameters.length - 4}</small>}{parameters.length === 0 && <small>未识别到可编辑超参数</small>}</div><dl><div><dt>工作目录</dt><dd>{selectedProfileProject ? '随所选服务器的项目副本切换' : profile.workingDirectory}</dd></div><div><dt>默认资源</dt><dd>{profile.gpuCount ? `${profile.gpuCount} 张 GPU${profile.minimumGpuMemoryGb ? ` · 每卡空闲 ≥ ${profile.minimumGpuMemoryGb} GB` : ''}` : 'CPU'}</dd></div><div><dt>最近运行</dt><dd>{formatTimestamp(latest?.startedAt)}</dd></div></dl></article>})}</div> : <div className="managed-profile-project-empty"><SlidersHorizontal size={22} /><strong>这个项目还没有启动配置</strong><p>保存一套命令和超参数后，可以在项目的任意服务器副本上调整 GPU 卡号并启动。</p><button className="button button--secondary" onClick={() => openLaunch(defaultProfile(projects, selectedProfileProject?.id ?? null), undefined, selectedProfileProject?.id ?? null)}><Plus size={14} />添加配置</button></div>}</div></div></section>}

    {tab === 'recent' && <section className="managed-recent-view"><header><div><h2>最近结束</h2><p>仅保留 RackTop 管理任务的结果和日志入口。</p></div></header>{recentRuns.length ? <div className="managed-recent-list">{recentRuns.map((run) => { const server = servers.find((item) => item.id === run.serverId); return <div key={run.id}><span className={`managed-exit-state is-${run.status}`}>{run.status === 'completed' ? <CheckCircle2 size={13} /> : run.status === 'stopped' ? <Square size={10} fill="currentColor" /> : <AlertCircle size={13} />}</span><span><strong>{run.name}</strong><small>{server?.name ?? '服务器已移除'} · {run.gpuIndices.length ? `GPU ${run.gpuIndices.join(', ')}` : 'CPU'}</small></span><span><strong>{run.status === 'completed' ? '正常完成' : run.status === 'stopped' ? '手动结束' : `意外退出${run.exitCode == null ? '' : ` · 代码 ${run.exitCode}`}`}</strong><small>运行 {relativeDuration(run.startedAt)}</small></span><time>{formatTimestamp(run.endedAt)}</time><button className="button button--secondary button--small" onClick={() => void restartRun(run)}><RefreshCw size={12} />再次运行</button></div>})}</div> : <div className="managed-process-empty"><CheckCircle2 size={27} /><strong>没有最近结束的任务</strong><p>完成、停止或意外退出的 RackTop 任务会显示在这里。</p></div>}</section>}

    {launchOpen && <div className="scrim">
      <section className="sheet managed-launch-sheet" role="dialog" aria-modal="true" aria-labelledby="managed-launch-title">
        <header className="sheet__header"><div><p className="eyebrow">启动任务</p><h2 id="managed-launch-title">确认项目、算力与命令</h2></div><button className="icon-button" onClick={() => setLaunchOpen(false)} disabled={launching} aria-label="关闭"><X size={18} /></button></header>
        <div className="managed-launch-body">
          <aside><strong>启动配置</strong>
            {visibleProfileGroups.map((group) => <div className="managed-profile-group" key={group.id}>
              <button className="managed-profile-group__header" onClick={() => setCollapsedProfileGroups((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })} aria-expanded={!collapsedProfileGroups.has(group.id)}>
                <span>{group.name}<small>{group.profiles.length}</small></span>{collapsedProfileGroups.has(group.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
              {!collapsedProfileGroups.has(group.id) && <div className="managed-profile-group__items">{group.profiles.map((profile) => <button className={profile.id === launchProfile.id ? 'is-selected' : ''} key={profile.id} onClick={() => { setLaunchProfile({ ...profile }); setSelectedServerId(''); setLaunchError(null); setParametersOpen(false) }}><span>{profile.name}</span></button>)}</div>}
            </div>)}
            <button className={!profiles.some((profile) => profile.id === launchProfile.id) ? 'is-selected' : ''} onClick={() => { setLaunchProfile(defaultProfile(projects, launchProjectContextId)); setParametersOpen(false) }}><span>{launchProjectContextId ? '添加启动配置' : '临时任务'}</span><small>{launchProjectContextId ? '为当前项目创建模板' : '可选择保存配置'}</small></button>
          </aside>
          <div className="managed-launch-form">
            <section><header><span>1</span><div><strong>任务与命令</strong><small>工作目录、运行位置与后台日志由 RackTop 统一处理。</small></div></header>
              <div className="managed-launch-fields">
                <label>配置名称<input value={launchProfile.name} onChange={(event) => updateLaunchProfile({ name: event.target.value })} /></label>
                <label>关联项目<select value={launchProfile.projectId ?? ''} onChange={(event) => { const project = projects.find((item) => item.id === event.target.value); updateLaunchProfile({ projectId: project?.id ?? null, workingDirectory: project?.sourcePath ?? launchProfile.workingDirectory, datasetIds: project?.datasetIds ?? [] }); setLaunchProjectContextId(project?.id ?? null); setSelectedServerId('') }}><option value="">不关联项目</option>{projects.filter((project) => project.kind === 'project').map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
                <label className="is-wide">工作目录<input value={selectedProject ? selectedProjectPath || '所选服务器尚未配置项目副本' : launchProfile.workingDirectory} disabled={Boolean(selectedProject)} onChange={(event) => updateLaunchProfile({ workingDirectory: event.target.value })} /></label>
                <label className="is-wide">启动命令（自动替换工作目录和运行位置）<textarea rows={2} value={launchProfile.command} onChange={(event) => updateLaunchProfile({ command: event.target.value })} /></label>
                <label className="is-wide">项目日志路径（可选）<input placeholder="未设置时使用 RackTop 默认日志" value={launchProfile.projectLogPath ?? ''} onChange={(event) => updateLaunchProfile({ projectLogPath: event.target.value || null })} /></label>
              </div>
              {launchParameters.length > 0 && <div className="managed-parameter-editor">
                <button className="managed-parameter-editor__toggle" onClick={() => setParametersOpen((open) => !open)} aria-expanded={parametersOpen} aria-controls="managed-parameter-list"><span><strong>超参数</strong><small>{launchParameters.length} 项可编辑</small></span>{parametersOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                {parametersOpen && <div className="managed-parameter-editor__list" id="managed-parameter-list"><div className="managed-parameter-editor__head"><span>名称</span><span>值</span></div>{launchParameters.map((parameter) => <div className="managed-parameter-editor__row" key={`${parameter.start}-${parameter.name}`}><code title={parameter.name}>{parameter.name}</code>{parameter.hasValue ? <input aria-label={`${parameter.name} 的值`} value={parameter.value} onChange={(event) => updateLaunchProfile({ command: updateLaunchParameter(launchProfile.command, parameter, event.target.value) })} /> : <label><input type="checkbox" checked onChange={(event) => updateLaunchProfile({ command: updateLaunchParameter(launchProfile.command, parameter, '', event.target.checked) })} />启用</label>}</div>)}</div>}
              </div>}
            </section>
            <section><header><span>2</span><div><strong>运行位置</strong><small>{selectedProject ? '仅显示已配置当前项目的服务器。' : `自动推荐按空闲显存排序，也可以指定具体 ${selectedAccelerator}。`}</small></div></header><div className="managed-launch-server-list">{launchServers.map((server) => { const snapshot = snapshots[server.id]; const system = snapshot?.system; const accelerator = snapshot ? acceleratorLabel(snapshot) : 'GPU'; const availableMemoryBytes = system?.memoryAvailableBytes ?? Math.max(0, (system?.memoryTotalBytes ?? 0) - (system?.memoryUsedBytes ?? 0)); return <button className={server.id === selectedServerId ? 'is-selected' : ''} key={server.id} onClick={() => { setSelectedServerId(server.id); setSelectedGpuUuids([]); setLaunchError(null) }}><span><i className={`server-row__status server-row__status--${server.status}`} /><strong>{server.name}</strong></span><small>{snapshot?.gpus.length ?? 0} 张 {accelerator} · {formatMemoryBytes(availableMemoryBytes).replace(' GB', '')} / {formatMemoryBytes(system?.memoryTotalBytes ?? 0)} 系统 MEM 可用</small></button>})}{launchServers.length === 0 && <p className="managed-launch-server-empty">当前没有已配置该项目且在线的服务器，请先在“我的项目”中配置同步目标。</p>}</div><div className="managed-assignment-mode"><button className={assignmentMode === 'automatic' ? 'is-selected' : ''} onClick={() => setAssignmentMode('automatic')}>自动推荐</button><button className={assignmentMode === 'manual' ? 'is-selected' : ''} onClick={() => setAssignmentMode('manual')}>指定 {selectedAccelerator}</button></div><div className="managed-gpu-list">{availableGpus.map((gpu, index) => { const selected = selectedGpuUuids.includes(gpu.uuid); return <label className={selected ? 'is-selected' : ''} key={gpu.uuid}><input type="checkbox" checked={selected} disabled={assignmentMode === 'automatic'} onChange={(event) => setSelectedGpuUuids((current) => event.target.checked ? [...current, gpu.uuid] : current.filter((uuid) => uuid !== gpu.uuid))} /><span><strong>{selectedAccelerator} {gpu.index}</strong><small>{((gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} / {(gpu.memoryTotalMb / 1024).toFixed(1)} GB MEM 可用</small></span>{assignmentMode === 'automatic' && index < launchProfile.gpuCount && <em>推荐</em>}</label>})}{selectedServerId && availableGpus.length === 0 && <p>没有满足当前筛选条件的 {selectedAccelerator}。</p>}</div><div className="managed-resource-fields"><label>{selectedAccelerator} 数量<input type="number" min="0" max="16" value={launchProfile.gpuCount} onChange={(event) => updateLaunchProfile({ gpuCount: Math.max(0, Number(event.target.value) || 0) })} /></label><label>每卡最低空闲显存<input type="number" min="0" value={launchProfile.minimumGpuMemoryGb} onChange={(event) => updateLaunchProfile({ minimumGpuMemoryGb: Math.max(0, Number(event.target.value) || 0) })} /></label><label className="managed-resource-occupancy"><span>{selectedAccelerator} 使用情况</span><span className="managed-resource-occupancy__control"><span>是否独占</span><input type="checkbox" checked={excludeOccupiedGpus} onChange={(event) => setExcludeOccupiedGpus(event.target.checked)} /></span></label></div></section>
            <section><header><span>3</span><div><strong>启动前检查</strong><small>项目、数据集和模型只在确实缺少副本时同步。</small></div></header><div className="managed-preflight"><div><CheckCircle2 size={15} /><span><strong>{selectedProject?.name ?? '临时命令'}</strong><small>{selectedProject ? selectedProjectPath || '所选服务器没有项目副本' : launchProfile.workingDirectory}</small></span></div>{selectedProject?.datasetIds.map((id) => { const dataset = projects.find((item) => item.id === id); const path = dataset && selectedServerId ? projectPathOnServer(dataset, selectedServerId) : ''; return dataset ? <div key={id}><Database size={15} /><span><strong>{dataset.name}</strong><small>{path || '所选服务器尚未配置数据集副本'}</small></span></div> : null })}{selectedProject?.modelIds.map((id) => { const model = projects.find((item) => item.id === id); const path = model && selectedServerId ? projectPathOnServer(model, selectedServerId) : ''; return model ? <div key={id}><Box size={15} /><span><strong>{model.name}</strong><small>{path || '所选服务器尚未配置模型副本'}</small></span></div> : null })}<label><input type="checkbox" checked={syncDependencies} onChange={(event) => setSyncDependencies(event.target.checked)} /><span><strong>启动前补齐待更新副本</strong><small>遇到冲突时停止启动，不覆盖远端修改。</small></span></label></div><pre className="managed-command-preview"><code>{replaceLaunchContext(launchProfile.command, selectedProjectPath || launchProfile.workingDirectory, selectedGpuIndices)}{'\n\n'}# RackTop 受管日志: ~/.racktop/runs/&lt;task-id&gt;/output.log{launchProfile.projectLogPath ? `\n# 同步到项目: ${resolveProjectLogPath(launchProfile.projectLogPath, launchProfile.command)}` : ''}</code></pre><label className="managed-save-profile"><input type="checkbox" checked={saveProfile} onChange={(event) => setSaveProfile(event.target.checked)} />启动后保存为启动配置</label>{launchError && <p className="form-error" role="alert">{launchError}</p>}</section>
          </div>
        </div>
        <footer className="sheet__footer"><span className="managed-launch-readiness">{selectedGpuUuids.length === launchProfile.gpuCount && (selectedProjectPath || launchProfile.workingDirectory) ? <><CheckCircle2 size={13} />配置完整，可以启动</> : <><AlertCircle size={13} />请完成运行位置与资源选择</>}</span><button className="button button--secondary" onClick={() => setLaunchOpen(false)} disabled={launching}>取消</button><button className="button button--secondary" onClick={saveLaunchProfile} disabled={launching}><Save size={14} />{profiles.some((profile) => profile.id === launchProfile.id) ? '保存配置' : '添加配置'}</button><button className="button button--primary" onClick={() => void launch()} disabled={launching}>{launching ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{launching ? '正在准备…' : '启动任务'}</button></footer>
      </section>
    </div>}

    {logRun && <aside className="managed-log-inspector"><header><div><p className="eyebrow">实时日志</p><h2>{logRun.name}</h2></div><button className="icon-button" onClick={() => setLogRun(null)} aria-label="关闭"><X size={16} /></button></header><div className="managed-log-meta"><span>{servers.find((server) => server.id === logRun.serverId)?.name ?? '服务器已移除'}</span><span>{logRun.gpuIndices.length ? `GPU ${logRun.gpuIndices.join(', ')}` : 'CPU'}</span></div><pre>{loadingLog ? '正在读取远端日志…' : logContent || '日志暂时为空。'}</pre><footer><button className="button button--secondary" onClick={() => void openLog(logRun)}><RefreshCw size={13} />刷新日志</button><button className="button button--primary" onClick={() => onOpenTerminal(logRun.serverId)}><TerminalSquare size={13} />打开终端</button></footer></aside>}

    {pendingAssociation && <div className="scrim"><section className="sheet managed-association-sheet" role="dialog" aria-modal="true" aria-labelledby="managed-association-title"><header className="sheet__header"><div><p className="eyebrow">关联项目</p><h2 id="managed-association-title">将外部进程纳入任务视图</h2></div><button className="icon-button" onClick={() => setPendingAssociation(null)} aria-label="关闭"><X size={17} /></button></header><div className="managed-association-body"><div><span>当前进程</span><strong>{pendingAssociation.group.root.command}</strong><small>{pendingAssociation.server.name} · 根 PID {pendingAssociation.group.rootPid}</small></div><label>关联项目<select value={associationProjectId} onChange={(event) => setAssociationProjectId(event.target.value)}><option value="">请选择项目</option>{projects.filter((project) => project.kind === 'project').map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><p>进程的工作目录和日志无法从当前采样中确定，关联后未知字段会显示为“未获取”。</p></div><footer className="sheet__footer"><button className="button button--secondary" onClick={() => setPendingAssociation(null)}>取消</button><button className="button button--primary" onClick={associateProcess} disabled={!associationProjectId}><FolderGit2 size={13} />确认关联</button></footer></section></div>}

    {pendingStop && <div className="scrim"><section className="sheet managed-stop-sheet" role="alertdialog" aria-modal="true"><header><span><Square size={15} fill="currentColor" /></span><div><p className="eyebrow">结束远程任务</p><h2>确认结束“{pendingStop.name}”？</h2></div></header><p>将结束任务根 PID {pendingStop.pid} 及其子进程。未保存的训练状态可能丢失。</p><footer><button className="button button--secondary" onClick={() => setPendingStop(null)}>取消</button><button className="button button--danger" onClick={() => void stopRun()}><Square size={12} fill="currentColor" />结束任务</button></footer></section></div>}
    {pendingUnmanagedStop && <div className="scrim"><section className="sheet managed-stop-sheet" role="alertdialog" aria-modal="true"><header><span><Square size={15} fill="currentColor" /></span><div><p className="eyebrow">结束未关联进程</p><h2>确认结束 PID {pendingUnmanagedStop.group.rootPid}？</h2></div></header><p>将结束根 PID {pendingUnmanagedStop.group.rootPid} 及展开区中的子进程。该进程不由 RackTop 启动，不提供任务重启或任务日志。</p><footer><button className="button button--secondary" onClick={() => setPendingUnmanagedStop(null)}>取消</button><button className="button button--danger" onClick={() => void stopUnmanagedProcess()}><Square size={12} fill="currentColor" />结束进程</button></footer></section></div>}
  </div>
}
