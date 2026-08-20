import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  Bell,
  BellOff,
  BellPlus,
  Box,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  Cpu,
  Copy,
  Database,
  Download,
  ExternalLink,
  FolderGit2,
  Gauge,
  Github,
  GripVertical,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  ScrollText,
  MemoryStick,
  Minus,
  MoreHorizontal,
  Network,
  OctagonX,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server as ServerIcon,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Trash2,
  UserRound,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { api } from './services/api'
import { openExternalUrl } from './services/external'
import type { AppSettings, DetailTab, GpuMemoryStallWarning, HistoryHeatmapPoint, HistoryPoint, HostKeyInfo, IdleReservation, IdleReservationFilters, InteractionLogSummary, LinkedProjectResourcePlan, Project, ProjectDraft, ProjectSyncProgress, RemoteHistorySyncResult, Server, ServerDraft, Snapshot } from './types/models'
import { isRackTopManagedIdentity } from './utils/sshSetup'
import { DeleteServerDialog } from './components/DeleteServerDialog'
import { HistoryHeatmaps, StorageWaffleList } from './components/HistoryHeatmap'
import { MetricBar } from './components/MetricBar'
import { ManagedProcessView, type ManagedLaunchIntent } from './components/ManagedProcessView'
import { OnboardingChecklist, type OnboardingStep } from './components/OnboardingChecklist'
import { ProcessBlocks, type ProcessTerminationTarget } from './components/ProcessBlocks'
import { ProjectForm } from './components/ProjectForm'
import { ProjectConflictDialog, ProjectDeleteDialog, ProjectView, syncableProjectTargets } from './components/ProjectView'
import { isRemoteSyncFresh, RemoteSyncCoordinator, RemoteSyncStatus, REMOTE_SYNC_FEEDBACK_DELAY_MS, REMOTE_SYNC_SUCCESS_DURATION_MS, shouldRetryRemoteSyncAfterRecovery, shouldShowRemoteSyncImmediately, type RemoteSyncStatusState } from './components/RemoteSyncStatus'
import { ResourceTrend } from './components/ResourceTrend'
import { ServerForm } from './components/ServerForm'
import { SshTerminal } from './components/SshTerminal'
import { StatusPill } from './components/StatusPill'
import { TrendChart } from './components/TrendChart'
import { UsageDistribution } from './components/UsageDistribution'
import { aggregateGpuMemoryPercent, aggregateGpuSmUtilization, clampPercent, countOtherUserGpuWorkloads, displayedGpuMemoryPercent, gpuLoadAccent, gpuLoadLevel, gpuMemoryLevel, gpuMemoryPercent, isGpuAvailable, isGpuIdle } from './utils/gpu'
import { canDisplayServerDetails, serverStatusAfterFailure, shouldShowConnectingOnAttempt } from './utils/connectionStatus'
import { DEFAULT_IDLE_FILTERS, displayedFreeMemoryGb, idleFilterSummaryParts, loadIdleFilters, rankIdleGpuItems, saveIdleFilters, type IdleFilters, type IdleGpuItem } from './utils/idleFilters'
import { CURRENT_SNAPSHOT_STABLE_SECONDS, evaluateIdleReservation, idleReservationFiltersEqual, idleReservationGpuKey, idleReservationSummary } from './utils/idleReservations'
import { canOfferNvidiaDriverInstall, clearResolvedNvidiaWarningId, displayedNvidiaServerStatus, loadIgnoredNvidiaWarningIds, nvidiaIssueGuidance, nvidiaIssueTitle, saveIgnoredNvidiaWarningIds } from './utils/nvidiaStatus'
import { DISK_STATUS_INTERVAL_MS, FOREGROUND_STATUS_INTERVAL_MS, shouldCollectDetailData, shouldRecordHistory, statusRefreshIntervalMs } from './utils/refreshCadence'
import { deriveGpuMemoryStallWarnings, ignoredGpuMemoryStallGpus } from './utils/gpuMemoryWarnings'
import { acquiredDataItems, interactionDurationSeconds, interactionVisualStatus } from './utils/activityLog'
import { duplicateImportIndexes } from './utils/serverIdentity'
import { currentUserProcessCount } from './utils/processRelations'
import { previewServerOrder, serverDropTarget, type ServerDropPlacement } from './utils/serverOrder'
import { serverMatchesSearch } from './utils/serverSearch'
import { updateSharedGpuWarnings, type MineProcessWarning, type SharedGpuWatchMap } from './utils/mineProcessWarnings'
import { gpuContextName, serverDisplayName } from './utils/serverName'
import { loadLaunchProfiles, loadManagedRuns } from './utils/managedRuns'
import { detectAppPlatform } from './utils/platform'
import authorAvatar from './assets/tongzh-seu.png'
import packageInfo from '../package.json'

const appPlatform = detectAppPlatform(api.isDesktop, navigator.userAgent)

const ONBOARDING_DISMISSED_KEY = 'racktop.onboardingDismissed.v1'

const tabs: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'processes', label: '进程' },
  { value: 'terminal', label: navigator.userAgent.includes('Windows') ? '命令行' : '终端' },
  { value: 'history', label: '趋势' },
  { value: 'gpu', label: 'GPU' },
  { value: 'cpu', label: 'CPU' },
  { value: 'connection', label: '连接' },
]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatDataBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function formatClock(mhz: number) {
  if (!Number.isFinite(mhz) || mhz <= 0) return '0 MHz'
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await operation(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function relativeTime(timestamp?: number | null) {
  if (!timestamp) return '尚未刷新'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (!api.isDesktop || event.button !== 0 || event.detail !== 1) return
  if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [role="button"]')) return
  void getCurrentWindow().startDragging()
}

async function toggleWindowMaximize(event: MouseEvent<HTMLElement>) {
  if (!api.isDesktop || event.button !== 0) return
  if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [role="button"]')) return
  event.preventDefault()
  await getCurrentWindow().toggleMaximize()
}

function WindowsWindowControls() {
  if (appPlatform !== 'windows') return null
  return (
    <div className="window-controls" aria-label="窗口控制" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('window_minimize') }} aria-label="最小化窗口"><Minus size={15} /></button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('window_toggle_maximize') }} aria-label="最大化或还原窗口"><Square size={12} /></button>
      <button type="button" className="window-controls__close" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('window_close') }} aria-label="关闭窗口"><X size={15} /></button>
    </div>
  )
}

export function shouldShowGuidedEmptyState(mainView: string, serverCount: number) {
  return mainView === 'fleet' && serverCount === 0
}

function serverToDraft(server: Server): Partial<ServerDraft> {
  return {
    id: server.id,
    name: server.name,
    location: server.location ?? undefined,
    host: server.host,
    port: server.port,
    username: server.username,
    sshAlias: server.sshAlias ?? undefined,
    identityFile: server.identityFile ?? undefined,
    proxyJump: server.proxyJump ?? undefined,
    tags: server.tags,
    samplingIntervalSeconds: server.samplingIntervalSeconds,
    historyRetentionDays: server.historyRetentionDays,
    remoteHistoryEnabled: server.remoteHistoryEnabled,
    authMethod: server.authMethod,
  }
}

function evaluateAlerts(server: Server | undefined, snapshot: Snapshot, previous: Snapshot | undefined, settings: AppSettings, since: Record<string, number>, notified: Set<string>) {
  const serverName = serverDisplayName(server?.name ?? snapshot.hostname)
  const now = snapshot.timestamp
  const notifyCondition = (key: string, title: string, body: string) => {
    if (notified.has(key)) return
    notified.add(key)
    void api.notify(title, body)
  }
  const clearCondition = (key: string) => {
    delete since[key]
    notified.delete(key)
  }

  for (const gpu of snapshot.gpus) {
    const hotKey = `hot:${snapshot.serverId}:${gpu.uuid}`
    if (gpu.temperatureCelsius >= settings.temperatureThresholdCelsius) notifyCondition(hotKey, `${serverName} 温度告警`, `GPU ${gpu.index} 已达到 ${gpu.temperatureCelsius.toFixed(0)}°C`)
    else clearCondition(hotKey)

    const availableMb = gpu.memoryTotalMb - gpu.memoryUsedMb
    const idleKey = `idle:${snapshot.serverId}:${gpu.uuid}`
    if (isGpuIdle(gpu, settings.idleGpuThreshold)) {
      since[idleKey] ??= now
      if (now - since[idleKey] >= settings.idleDurationMinutes * 60) notifyCondition(idleKey, `${serverName} 有空闲 GPU`, `GPU ${gpu.index} 已空闲 ${settings.idleDurationMinutes} 分钟，可用显存 ${(availableMb / 1024).toFixed(1)} GB`)
    } else clearCondition(idleKey)

    const fullKey = `full:${snapshot.serverId}:${gpu.uuid}`
    if (gpu.utilization >= 95) {
      since[fullKey] ??= now
      if (now - since[fullKey] >= 30 * 60) notifyCondition(fullKey, `${serverName} GPU 持续满载`, `GPU ${gpu.index} 已持续 30 分钟超过 95%`)
    } else clearCondition(fullKey)

    const previousGpu = previous?.gpus.find((item) => item.uuid === gpu.uuid)
    if (previousGpu) {
      const previousAvailable = previousGpu.memoryTotalMb - previousGpu.memoryUsedMb
      const releasedKey = `released:${snapshot.serverId}:${gpu.uuid}`
      if (previousAvailable < settings.idleMemoryThresholdMb && availableMb >= settings.idleMemoryThresholdMb) notifyCondition(releasedKey, `${serverName} 显存已释放`, `GPU ${gpu.index} 当前可用 ${(availableMb / 1024).toFixed(1)} GB`)
      else if (availableMb < settings.idleMemoryThresholdMb) notified.delete(releasedKey)
    }
  }

  if (previous) {
    const currentPids = new Set(snapshot.processes.map((process) => process.pid))
    for (const process of previous.processes.filter((item) => item.isCurrentUser && !currentPids.has(item.pid))) {
      notifyCondition(`exit:${snapshot.serverId}:${process.pid}:${now}`, `${serverName} 任务已退出`, `${process.command}（PID ${process.pid}）已不在 GPU 进程列表中`)
    }
  }
}

function App() {
  const [servers, setServers] = useState<Server[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({})
  const [idleHistory, setIdleHistory] = useState<Record<string, HistoryPoint[]>>({})
  const [idleHistoryLoadedMinutes, setIdleHistoryLoadedMinutes] = useState(0)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [selectedTab, setSelectedTab] = useState<DetailTab>('overview')
  const [selectedGpuUuid, setSelectedGpuUuid] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [draggedServerId, setDraggedServerId] = useState<string | null>(null)
  const draggedServerIdRef = useRef<string | null>(null)
  const dragOriginalServersRef = useRef<Server[] | null>(null)
  const dragPreviewServersRef = useRef<Server[] | null>(null)
  const dragMouseRef = useRef<{ sourceId: string; startY: number; pointerY: number; grabOffsetY: number; active: boolean; rows: Array<{ id: string; top: number; bottom: number }> } | null>(null)
  const dragMouseCleanupRef = useRef<(() => void) | null>(null)
  const suppressServerClickRef = useRef(false)
  const serverRowRefs = useRef(new Map<string, HTMLButtonElement>())
  const [showServerForm, setShowServerForm] = useState(false)
  const [editingServer, setEditingServer] = useState<Server | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showActivityLog, setShowActivityLog] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [importingConfig, setImportingConfig] = useState(false)
  const [importDrafts, setImportDrafts] = useState<ServerDraft[] | null>(null)
  const [mainView, setMainView] = useState<'server' | 'fleet' | 'idle' | 'mine' | 'projects'>('fleet')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectEditor, setProjectEditor] = useState<Project | null | 'new'>(null)
  const [projectPendingDelete, setProjectPendingDelete] = useState<Project | null>(null)
  const [projectConflictTarget, setProjectConflictTarget] = useState<{ project: Project; targetServerId: string } | null>(null)
  const [busyProjectTargets, setBusyProjectTargets] = useState<Set<string>>(new Set())
  const [projectSyncProgress, setProjectSyncProgress] = useState<ProjectSyncProgress[]>([])
  const [preparingProjectIds, setPreparingProjectIds] = useState<Set<string>>(new Set())
  const [mineProcessWarnings, setMineProcessWarnings] = useState<MineProcessWarning[]>([])
  const [managedLaunchIntent, setManagedLaunchIntent] = useState<ManagedLaunchIntent | null>(null)
  const [onboardingPreviewStep, setOnboardingPreviewStep] = useState(0)
  const [onboardingCollapsed, setOnboardingCollapsed] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => localStorage.getItem(ONBOARDING_DISMISSED_KEY) === 'true')
  const [onboardingUseActualState, setOnboardingUseActualState] = useState(api.isDesktop)
  const [fleetSort, setFleetSort] = useState<'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount'>(() => (localStorage.getItem('racktop.fleetSort') as 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount') || 'name')
  const [fleetDescending, setFleetDescending] = useState(() => localStorage.getItem('racktop.fleetDescending') === 'true')
  const [idleFilters, setIdleFilters] = useState<IdleFilters>(loadIdleFilters)
  const [idleReservations, setIdleReservations] = useState<IdleReservation[]>([])
  const [gpuMemoryStallWarnings, setGpuMemoryStallWarnings] = useState<GpuMemoryStallWarning[]>([])
  const [showReservationCenter, setShowReservationCenter] = useState(false)
  const [reservationEditor, setReservationEditor] = useState<{ filters: IdleReservationFilters; reservation?: IdleReservation } | null>(null)
  const [quickTerminal, setQuickTerminal] = useState<{ server: Server; gpu?: Snapshot['gpus'][number] } | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [manualRefreshingAll, setManualRefreshingAll] = useState(false)
  const [manualRefreshProgress, setManualRefreshProgress] = useState<{ completed: number; total: number } | null>(null)
  const [manualRefreshRevision, setManualRefreshRevision] = useState(0)
  const [manualRefreshingServers, setManualRefreshingServers] = useState<Set<string>>(new Set())
  const [paused, setPaused] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [remoteSyncStatus, setRemoteSyncStatus] = useState<RemoteSyncStatusState | null>(null)
  const [initialCollectionComplete, setInitialCollectionComplete] = useState(false)
  const [remoteSyncRetryRevision, setRemoteSyncRetryRevision] = useState(0)
  const [ignoredNvidiaWarnings, setIgnoredNvidiaWarnings] = useState<Set<string>>(loadIgnoredNvidiaWarningIds)
  const [pendingHostKey, setPendingHostKey] = useState<HostKeyInfo | null>(null)
  const [serverPendingDelete, setServerPendingDelete] = useState<Server | null>(null)
  const [processPendingTermination, setProcessPendingTermination] = useState<(ProcessTerminationTarget & { serverId: string; serverName: string }) | null>(null)
  const [terminatingProcess, setTerminatingProcess] = useState<{ serverId: string; pid: number } | null>(null)
  const initialLoad = useRef(false)
  const manualRefreshFeedbackTimerRef = useRef<number | null>(null)
  const snapshotsRef = useRef<Record<string, Snapshot>>({})
  const sharedGpuWatchesRef = useRef<SharedGpuWatchMap>(new Map())
  const expectedProcessExitsRef = useRef(new Set<string>())
  const ignoredMineProcessWarningsRef = useRef<Set<string>>((() => {
    try {
      const value = JSON.parse(localStorage.getItem('racktop.ignoredMineProcessWarnings.v1') ?? '[]')
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
    } catch { return new Set() }
  })())
  const ignoredNvidiaWarningsRef = useRef(ignoredNvidiaWarnings)
  const mineProcessInfoTimersRef = useRef(new Map<string, number>())
  const failureCounts = useRef<Record<string, number>>({})
  const lastAttemptAt = useRef<Record<string, number>>({})
  const lastProcessAttemptAt = useRef<Record<string, number>>({})
  const lastDiskAttemptAt = useRef<Record<string, number>>({})
  const lastHistoryRecordedAt = useRef<Record<string, number>>({})
  const remoteHistoryServersRef = useRef<Server[]>([])
  const remoteSyncInFlight = useRef(new Set<string>())
  const remoteSyncRecoveryQueued = useRef(new Set<string>())
  const remoteSyncStatusRef = useRef<RemoteSyncStatusState | null>(null)
  const remoteSyncCoordinator = useRef(new RemoteSyncCoordinator())
  const remoteCleanupNoticeKeys = useRef(new Set<string>())
  const nextRetryAt = useRef<Record<string, number>>({})
  const inFlightServers = useRef(new Set<string>())
  const deletedServerIds = useRef(new Set<string>())
  const conditionSince = useRef<Record<string, number>>({})
  const notifiedConditions = useRef(new Set<string>())
  const idleReservationsRef = useRef<IdleReservation[]>([])
  const reservationPendingSince = useRef<Record<string, Record<string, number>>>({})
  const gpuMemoryStallSince = useRef<Record<string, number>>((() => {
    try {
      const value = JSON.parse(localStorage.getItem('racktop.gpuMemoryStallSince.v1') ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  })())
  const notifiedGpuMemoryStalls = useRef(new Set<string>())
  const [ignoredGpuMemoryStallWarningIds, setIgnoredGpuMemoryStallWarningIds] = useState<Set<string>>(() => {
    if (typeof localStorage === 'undefined') return new Set<string>()
    try {
      const value = JSON.parse(localStorage.getItem('racktop.ignoredGpuMemoryStallWarnings.v1') ?? '[]')
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
    } catch { return new Set() }
  })

  const selectedServer = servers.find((server) => server.id === selectedServerId)
  const selectedSnapshot = selectedServerId ? snapshots[selectedServerId] : undefined
  const remoteHistoryServerKey = servers.filter((server) => server.remoteHistoryEnabled).map((server) => server.id).sort().join('\n')

  useEffect(() => { remoteHistoryServersRef.current = servers }, [servers])
  useEffect(() => { remoteSyncStatusRef.current = remoteSyncStatus }, [remoteSyncStatus])

  const refreshServer = useCallback(async (serverId: string, quiet = false) => {
    if (inFlightServers.current.has(serverId)) return
    const nowMs = Date.now()
    const serverConfig = servers.find((server) => server.id === serverId)
    if (quiet && serverConfig) {
      const fastStatusView = mainView === 'fleet' || (mainView === 'server' && selectedTab === 'overview' && selectedServerId === serverId)
      const refreshIntervalMs = statusRefreshIntervalMs(fastStatusView, document.hidden, serverConfig.samplingIntervalSeconds, settings?.backgroundSamplingIntervalSeconds ?? 15)
      if (nowMs - (lastAttemptAt.current[serverId] ?? 0) < refreshIntervalMs || nowMs < (nextRetryAt.current[serverId] ?? 0)) return
    }
    lastAttemptAt.current[serverId] = nowMs
    if (!quiet) delete nextRetryAt.current[serverId]
    inFlightServers.current.add(serverId)
    setBusy((current) => new Set(current).add(serverId))
    if (shouldShowConnectingOnAttempt(quiet, Boolean(snapshotsRef.current[serverId]), failureCounts.current[serverId] ?? 0)) {
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: 'connecting', lastError: null } : server))
    }
    try {
      const previous = snapshotsRef.current[serverId]
      const fastStatusView = !document.hidden && (mainView === 'fleet' || (mainView === 'server' && selectedTab === 'overview' && selectedServerId === serverId))
      const collectDetailData = shouldCollectDetailData(quiet, Boolean(previous))
      const includeProcesses = collectDetailData && (!quiet || fastStatusView || nowMs - (lastProcessAttemptAt.current[serverId] ?? 0) >= (settings?.processIntervalSeconds ?? 5) * 1000)
      const includeDisks = collectDetailData && (!quiet || nowMs - (lastDiskAttemptAt.current[serverId] ?? 0) >= DISK_STATUS_INTERVAL_MS)
      const recordHistory = !serverConfig || shouldRecordHistory(lastHistoryRecordedAt.current[serverId], nowMs, serverConfig.samplingIntervalSeconds)
      const collected = await api.collectServer(serverId, includeProcesses, includeDisks, recordHistory, !quiet)
      if (deletedServerIds.current.has(serverId)) return
      if (collected.processesSampled) lastProcessAttemptAt.current[serverId] = nowMs
      if (includeDisks) lastDiskAttemptAt.current[serverId] = nowMs
      const snapshot = {
        ...collected,
        ...(!collected.processesSampled ? { processes: previous?.processes ?? [], cpuProcesses: previous?.cpuProcesses ?? [] } : {}),
        ...(!includeDisks ? { disks: previous?.disks ?? [] } : {}),
      }
      const exited = (previous?.processes.filter((process) => process.isCurrentUser && !snapshot.processes.some((current) => current.pid === process.pid)) ?? []).filter((process) => {
        const key = `exit:${serverId}:${process.pid}`
        if (!expectedProcessExitsRef.current.has(key)) return true
        expectedProcessExitsRef.current.delete(key)
        return false
      })
      const serverName = serverDisplayName(serverConfig?.name ?? snapshot.hostname)
      const sharedWarnings = updateSharedGpuWarnings(serverName, snapshot, sharedGpuWatchesRef.current)
      const nextServerWarnings: MineProcessWarning[] = [
        ...exited.map((process) => ({ id: `exit:${serverId}:${process.pid}`, serverId, message: `${serverName} · 你的 GPU 进程意外退出：PID ${process.pid}`, tone: 'warning' as const })),
        ...sharedWarnings,
      ]
      const activeWarningIds = new Set(nextServerWarnings.map((warning) => warning.id))
      let ignoredWarningsChanged = false
      for (const id of ignoredMineProcessWarningsRef.current) {
        if ((id.startsWith(`exit:${serverId}:`) || id.startsWith(`shared:${serverId}:`)) && !activeWarningIds.has(id)) {
          ignoredMineProcessWarningsRef.current.delete(id)
          ignoredWarningsChanged = true
        }
      }
      if (ignoredWarningsChanged) localStorage.setItem('racktop.ignoredMineProcessWarnings.v1', JSON.stringify([...ignoredMineProcessWarningsRef.current]))
      setMineProcessWarnings((current) => [
        ...current.filter((warning) => warning.serverId !== serverId || warning.id.startsWith('exit:')),
        ...nextServerWarnings.filter((warning) => !ignoredMineProcessWarningsRef.current.has(warning.id)),
      ])
      snapshotsRef.current = { ...snapshotsRef.current, [serverId]: snapshot }
      if (shouldRetryRemoteSyncAfterRecovery(remoteSyncStatusRef.current, serverId, remoteSyncRecoveryQueued.current.has(serverId))) {
        remoteSyncRecoveryQueued.current.add(serverId)
        setRemoteSyncRetryRevision((revision) => revision + 1)
      }
      failureCounts.current[serverId] = 0
      delete nextRetryAt.current[serverId]
      notifiedConditions.current.delete(`offline:${serverId}`)
      if (settings) evaluateAlerts(servers.find((server) => server.id === serverId), snapshot, previous, settings, conditionSince.current, notifiedConditions.current)
      const retainedNvidiaWarnings = clearResolvedNvidiaWarningId(ignoredNvidiaWarningsRef.current, serverId, snapshot.nvidiaSmi)
      if (retainedNvidiaWarnings !== ignoredNvidiaWarningsRef.current) {
        ignoredNvidiaWarningsRef.current = retainedNvidiaWarnings
        setIgnoredNvidiaWarnings(retainedNvidiaWarnings)
        saveIgnoredNvidiaWarningIds(retainedNvidiaWarnings)
      }
      setSnapshots((current) => ({ ...current, [serverId]: snapshot }))
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: displayedNvidiaServerStatus(snapshot, retainedNvidiaWarnings.has(serverId)), lastSeenAt: snapshot.timestamp, lastError: snapshot.nvidiaMessage } : server))
      if (recordHistory) {
        lastHistoryRecordedAt.current[serverId] = nowMs
        const from = snapshot.timestamp - (settings?.realtimeWindowMinutes ?? 30) * 60
        try {
          const points = await api.getHistory(serverId, from)
          if (!deletedServerIds.current.has(serverId)) setHistory((current) => ({ ...current, [serverId]: points }))
        } catch (historyError) {
          if (!quiet) setToast(`历史数据读取失败：${String(historyError)}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failureCounts.current[serverId] = (failureCounts.current[serverId] ?? 0) + 1
      const failureCount = failureCounts.current[serverId]
      const retryDelays = [1, 2, 5, 10, 30]
      nextRetryAt.current[serverId] = Date.now() + retryDelays[Math.min(failureCount - 1, retryDelays.length - 1)] * 1000
      if (failureCount >= 3) {
        const key = `offline:${serverId}`
        if (!notifiedConditions.current.has(key)) {
          notifiedConditions.current.add(key)
          const name = serverDisplayName(servers.find((server) => server.id === serverId)?.name ?? serverId)
          void api.notify(`${name} 已离线`, `连续 ${failureCounts.current[serverId]} 次采集失败：${message}`)
        }
      }
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: serverStatusAfterFailure(failureCount), lastError: `${message} · ${retryDelays[Math.min(failureCount - 1, retryDelays.length - 1)]} 秒后重试` } : server))
      if (message.includes('主机指纹')) {
        try {
          setPendingHostKey(await api.scanHostKey(serverId))
        } catch (scanError) {
          if (!quiet) setToast(String(scanError))
        }
      }
      if (!quiet) setToast(message)
    } finally {
      inFlightServers.current.delete(serverId)
      setBusy((current) => {
        const next = new Set(current)
        next.delete(serverId)
        return next
      })
    }
  }, [mainView, selectedServerId, selectedTab, settings, servers])

  const setNvidiaWarningIgnored = useCallback((serverId: string, ignored: boolean) => {
    const next = new Set(ignoredNvidiaWarningsRef.current)
    if (ignored) next.add(serverId)
    else next.delete(serverId)
    ignoredNvidiaWarningsRef.current = next
    setIgnoredNvidiaWarnings(next)
    saveIgnoredNvidiaWarningIds(next)
    const snapshot = snapshotsRef.current[serverId]
    if (snapshot) setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: displayedNvidiaServerStatus(snapshot, ignored) } : server))
    setToast(ignored ? '已忽略此服务器的 GPU 异常提醒，可在采集与连接日志中恢复' : '已恢复 GPU 异常提醒')
  }, [])

  const refreshAll = useCallback(async (quiet = false, onSettled?: () => void) => {
    await Promise.allSettled(servers.map(async (server) => {
      try { await refreshServer(server.id, quiet) } finally { onSettled?.() }
    }))
  }, [servers, refreshServer])

  const runManualRefreshAll = useCallback(async () => {
    if (manualRefreshingAll) return
    if (manualRefreshFeedbackTimerRef.current !== null) window.clearTimeout(manualRefreshFeedbackTimerRef.current)
    setManualRefreshingAll(true)
    setManualRefreshProgress({ completed: 0, total: servers.length })
    try {
      await refreshAll(false, () => setManualRefreshProgress((current) => current ? { ...current, completed: current.completed + 1 } : current))
      setManualRefreshRevision((value) => value + 1)
    } finally {
      setManualRefreshingAll(false)
      manualRefreshFeedbackTimerRef.current = window.setTimeout(() => {
        setManualRefreshProgress(null)
        manualRefreshFeedbackTimerRef.current = null
      }, 900)
    }
  }, [manualRefreshingAll, refreshAll, servers.length])

  useEffect(() => () => {
    if (manualRefreshFeedbackTimerRef.current !== null) window.clearTimeout(manualRefreshFeedbackTimerRef.current)
  }, [])

  const runManualRefreshServer = useCallback(async (serverId: string) => {
    setManualRefreshingServers((current) => new Set(current).add(serverId))
    try { await refreshServer(serverId, false) } finally {
      setManualRefreshingServers((current) => {
        const next = new Set(current)
        next.delete(serverId)
        return next
      })
    }
  }, [refreshServer])

  useEffect(() => {
    void Promise.all([api.listServers(), api.getSettings(), api.listIdleReservations(), api.listProjects()]).then(([loadedServers, loadedSettings, loadedReservations, loadedProjects]) => {
      setServers(loadedServers)
      setSettings(loadedSettings)
      idleReservationsRef.current = loadedReservations
      setIdleReservations(loadedReservations)
      setProjects(loadedProjects)
      setSelectedServerId((current) => current ?? loadedServers[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!api.isDesktop || (mainView !== 'projects' && busyProjectTargets.size === 0)) return
    let cancelled = false
    const load = () => void api.listProjectSyncProgress().then((progress) => { if (!cancelled) setProjectSyncProgress(progress) }).catch(() => {})
    load()
    const interval = window.setInterval(load, 500)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [mainView, busyProjectTargets.size])

  useEffect(() => {
    if (mainView !== 'projects' || projects.length === 0 || busyProjectTargets.size > 0 || preparingProjectIds.size > 0) return
    let cancelled = false
    void mapWithConcurrency(projects, 2, (project) => api.inspectProjectSource(project.id).catch(() => null)).then((inspected) => {
      if (cancelled) return
      const inspectedById = new Map(inspected.filter((project): project is Project => Boolean(project)).map((project) => [project.id, project]))
      if (inspectedById.size > 0) setProjects((current) => current.map((project) => inspectedById.get(project.id) ?? project))
    })
    return () => { cancelled = true }
  }, [mainView, projects.length, busyProjectTargets.size, preparingProjectIds.size])

  useEffect(() => {
    if (!api.isDesktop) return
    let cancelled = false
    const retryRemoteCleanups = async () => {
      try {
        const result = await api.retryRemoteCleanups()
        if (cancelled) return
        if (result.pendingNames.length > 0 && !remoteCleanupNoticeKeys.current.has('pending')) {
          remoteCleanupNoticeKeys.current.add('pending')
          const names = result.pendingNames.map(serverDisplayName).join('、')
          void api.notify(`${names} 远端清理等待重连`, '已从服务器列表移除；RackTop 将在 24 小时内继续自动重试。')
          setToast(`${names} 的远端数据清理等待重连，自动重试最多 24 小时`)
        }
        if (result.expiredNames.length > 0 && !remoteCleanupNoticeKeys.current.has('expired')) {
          remoteCleanupNoticeKeys.current.add('expired')
          const names = result.expiredNames.map(serverDisplayName).join('、')
          void api.notify(`${names} 远端数据需要手动清理`, `自动清理已超过 24 小时。请 SSH 登录后执行：if [ -f ~/.racktop/.daemon.pid ]; then kill "$(cat ~/.racktop/.daemon.pid)" 2>/dev/null || true; fi; rm -rf -- ~/.racktop`)
          setToast(`${names} 的远端自动清理已超过 24 小时，请查看系统通知并手动清理`)
        }
      } catch (error) {
        if (!cancelled) setToast(`远端删除任务检查失败：${String(error)}`)
      }
    }
    void retryRemoteCleanups()
    const interval = window.setInterval(() => void retryRemoteCleanups(), 5 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    if (servers.length === 0 || initialLoad.current) return
    initialLoad.current = true
    void refreshAll(true).finally(() => setInitialCollectionComplete(true))
  }, [servers.length, refreshAll])

  useEffect(() => {
    if (!settings || servers.length === 0 || paused) return
    const interval = window.setInterval(() => void refreshAll(true), FOREGROUND_STATUS_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [settings, servers.length, refreshAll, paused])

  useEffect(() => {
    if (!api.isDesktop || !remoteHistoryServerKey || !initialCollectionComplete) {
      remoteSyncRecoveryQueued.current.clear()
      setRemoteSyncStatus(null)
      return
    }
    let cancelled = false
    let feedbackTimer: number | null = null
    let successTimer: number | null = null
    const syncAllRemoteHistory = async (initial: boolean) => remoteSyncCoordinator.current.run(async () => {
      if (cancelled) return
      const allEnabledServers = remoteHistoryServersRef.current.filter((server) => server.remoteHistoryEnabled)
      const nowSeconds = Math.floor(Date.now() / 1000)
      const freshServerCount = initial ? allEnabledServers.filter((server) => isRemoteSyncFresh(server, nowSeconds)).length : 0
      const enabledServers = allEnabledServers.filter((server) => (!initial || !isRemoteSyncFresh(server, nowSeconds)) && !remoteSyncInFlight.current.has(server.id))
      if (enabledServers.length === 0) return
      let completed = freshServerCount
      const total = allEnabledServers.length
      let importedCount = 0
      const failedServerIds: string[] = []
      const recoveryRetry = enabledServers.some((server) => remoteSyncRecoveryQueued.current.has(server.id))
      let visible = recoveryRetry || (initial && shouldShowRemoteSyncImmediately(allEnabledServers, nowSeconds))
      const syncingState = (): RemoteSyncStatusState => ({ phase: 'syncing', completed, total, importedCount, failedServerIds: [] })
      if (visible && !cancelled) setRemoteSyncStatus(syncingState())
      else if (initial) {
        feedbackTimer = window.setTimeout(() => {
          visible = true
          if (!cancelled) setRemoteSyncStatus(syncingState())
        }, REMOTE_SYNC_FEEDBACK_DELAY_MS)
      }
      await Promise.all(enabledServers.map(async (server) => {
        if (remoteSyncInFlight.current.has(server.id)) return
        remoteSyncInFlight.current.add(server.id)
        try {
          let result: RemoteHistorySyncResult | null = null
          let lastError: unknown = null
          for (const delay of [0, 1_000, 2_000]) {
            if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
            try {
              await api.configureRemoteHistory(server.id)
              result = await api.syncRemoteHistory(server.id)
              lastError = null
              break
            } catch (reason) {
              lastError = reason
            }
          }
          if (lastError || !result) throw lastError ?? new Error('历史同步未返回结果')
          remoteSyncRecoveryQueued.current.delete(server.id)
          importedCount += result.importedCount
          if (!cancelled && result.latestTimestamp) {
            setServers((current) => current.map((item) => item.id === server.id && item.remoteHistoryLastSyncAt !== result.latestTimestamp ? { ...item, remoteHistoryLastSyncAt: result.latestTimestamp } : item))
          }
        } catch {
          failedServerIds.push(server.id)
        } finally {
          completed += 1
          remoteSyncInFlight.current.delete(server.id)
          if (visible && !cancelled) setRemoteSyncStatus(syncingState())
        }
      }))
      if (feedbackTimer !== null) {
        window.clearTimeout(feedbackTimer)
        feedbackTimer = null
      }
      if (cancelled) return
      if (failedServerIds.length > 0) {
        setRemoteSyncStatus({ phase: 'error', completed, total, importedCount, failedServerIds })
      } else if (initial && visible) {
        setRemoteSyncStatus({ phase: 'success', completed, total, importedCount, failedServerIds: [] })
        successTimer = window.setTimeout(() => setRemoteSyncStatus(null), REMOTE_SYNC_SUCCESS_DURATION_MS)
      } else {
        setRemoteSyncStatus(null)
      }
    })
    void syncAllRemoteHistory(true)
    const interval = window.setInterval(() => { void syncAllRemoteHistory(false) }, 5 * 60_000)
    return () => {
      cancelled = true
      setRemoteSyncStatus(null)
      window.clearInterval(interval)
      if (feedbackTimer !== null) window.clearTimeout(feedbackTimer)
      if (successTimer !== null) window.clearTimeout(successTimer)
    }
  }, [remoteHistoryServerKey, remoteSyncRetryRevision, initialCollectionComplete])

  useEffect(() => {
    if (!api.isDesktop) return
    const unlistenTray = listen<string>('tray-action', ({ payload }) => {
      if (payload === 'reservations') setShowReservationCenter(true)
      else if (payload === 'mine-processes') setMainView('mine')
    })
    const unlistenMenu = listen<string>('app-menu-action', ({ payload }) => {
      if (payload === 'menu-about') setShowAbout(true)
      else if (payload === 'menu-settings') setShowSettings(true)
      else if (payload === 'menu-add-server') { setEditingServer(null); setShowServerForm(true) }
      else if (payload === 'menu-import-config') void importConfig()
      else if (payload === 'menu-refresh-all') void runManualRefreshAll()
      else if (payload === 'menu-view-fleet') setMainView('fleet')
      else if (payload === 'menu-view-idle') setMainView('idle')
      else if (payload === 'menu-view-mine') setMainView('mine')
      else if (payload === 'menu-view-logs') setShowActivityLog(true)
      else if (payload === 'menu-help-guide') void openExternalUrl('https://github.com/Tongzh-SEU/RackTop/blob/main/README.md')
      else if (payload === 'menu-help-project') void openExternalUrl('https://github.com/Tongzh-SEU/RackTop')
    })
    return () => {
      void unlistenTray.then((dispose) => dispose())
      void unlistenMenu.then((dispose) => dispose())
    }
  }, [runManualRefreshAll])

  useEffect(() => {
    const unlisten = api.onNotificationAction((extra) => {
      const serverId = typeof extra.serverId === 'string' ? extra.serverId : null
      const gpuUuid = typeof extra.gpuUuid === 'string' ? extra.gpuUuid : null
      if (!serverId || !gpuUuid) return
      setSelectedServerId(serverId)
      setSelectedGpuUuid(gpuUuid)
      setSelectedTab('gpu')
      setMainView('server')
      if (api.isDesktop) {
        void getCurrentWindow().show()
        void getCurrentWindow().setFocus()
      }
    })
    return () => { void unlisten.then((dispose) => dispose()) }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    const activeInfoIds = new Set(mineProcessWarnings.filter((warning) => warning.tone === 'info').map((warning) => warning.id))
    for (const warningId of activeInfoIds) {
      if (mineProcessInfoTimersRef.current.has(warningId)) continue
      const timeout = window.setTimeout(() => {
        mineProcessInfoTimersRef.current.delete(warningId)
        setMineProcessWarnings((current) => current.filter((warning) => warning.id !== warningId))
      }, 3_000)
      mineProcessInfoTimersRef.current.set(warningId, timeout)
    }
    for (const [warningId, timeout] of mineProcessInfoTimersRef.current) {
      if (activeInfoIds.has(warningId)) continue
      window.clearTimeout(timeout)
      mineProcessInfoTimersRef.current.delete(warningId)
    }
  }, [mineProcessWarnings])

  useEffect(() => () => {
    for (const timeout of mineProcessInfoTimersRef.current.values()) window.clearTimeout(timeout)
    mineProcessInfoTimersRef.current.clear()
  }, [])

  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
    document.documentElement.style.setProperty('--own-accent', settings.currentUserAccent)
  }, [settings])

  useEffect(() => {
    localStorage.setItem('racktop.fleetSort', fleetSort)
    localStorage.setItem('racktop.fleetDescending', String(fleetDescending))
  }, [fleetSort, fleetDescending])

  useEffect(() => { saveIdleFilters(idleFilters) }, [idleFilters])

  const requiredIdleHistoryMinutes = Math.max(
    idleFilters.duration,
    reservationEditor?.filters.duration ?? 0,
    ...idleReservations.filter((reservation) => reservation.status === 'active').map((reservation) => reservation.filters.duration),
  )
  const idleHistoryServerKey = servers.map((server) => server.id).sort().join('\n')

  useEffect(() => {
    if (requiredIdleHistoryMinutes <= 0 || servers.length === 0) {
      setIdleHistory({})
      setIdleHistoryLoadedMinutes(0)
      return
    }
    let cancelled = false
    const loadIdleHistory = async () => {
      const entries = await Promise.all(servers.map(async (server) => {
        const latestTimestamp = snapshotsRef.current[server.id]?.timestamp ?? Math.floor(Date.now() / 1000)
        const from = latestTimestamp - requiredIdleHistoryMinutes * 60 - 120
        return [server.id, await api.getHistory(server.id, from)] as const
      }))
      if (!cancelled) {
        setIdleHistory(Object.fromEntries(entries))
        setIdleHistoryLoadedMinutes(requiredIdleHistoryMinutes)
      }
    }
    void loadIdleHistory().catch((error) => setToast(`空闲历史读取失败：${String(error)}`))
    const interval = window.setInterval(() => void loadIdleHistory().catch(() => {}), 15_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [idleHistoryServerKey, requiredIdleHistoryMinutes])

  const idleFilterHistory = useMemo(() => {
    const serverIds = new Set([...Object.keys(history), ...Object.keys(idleHistory)])
    return Object.fromEntries([...serverIds].map((serverId) => {
      const points = new Map<number, HistoryPoint>()
      for (const point of idleHistory[serverId] ?? []) points.set(point.timestamp, point)
      for (const point of history[serverId] ?? []) points.set(point.timestamp, point)
      return [serverId, [...points.values()].sort((left, right) => left.timestamp - right.timestamp)]
    }))
  }, [history, idleHistory])
  const idleHistoryReady = requiredIdleHistoryMinutes <= 0 || (idleHistoryLoadedMinutes >= requiredIdleHistoryMinutes && servers.every((server) => server.id in idleHistory))

  useEffect(() => {
    const currentReservations = idleReservationsRef.current
    if (!idleHistoryReady || currentReservations.length === 0 || servers.length === 0 || Object.keys(snapshots).length === 0) return
    const nowSeconds = Math.max(Math.floor(Date.now() / 1000), ...Object.values(snapshots).map((snapshot) => snapshot.timestamp))
    let anyChanged = false
    const changedReservations: IdleReservation[] = []
    const nextReservations = currentReservations.map((reservation) => {
      const matchingItems = rankIdleGpuItems(servers, snapshots, idleFilterHistory, reservation.filters).filter((item) => item.available)
      const matchingKeys = matchingItems.map(({ server, gpu }) => idleReservationGpuKey(server.id, gpu.uuid))
      const evaluation = evaluateIdleReservation(reservation, matchingKeys, reservationPendingSince.current[reservation.id] ?? {}, nowSeconds)
      reservationPendingSince.current[reservation.id] = evaluation.pendingSince
      if (evaluation.changed) {
        anyChanged = true
        changedReservations.push(evaluation.reservation)
      }
      for (const key of evaluation.notificationGpuKeys) {
        const item = matchingItems.find(({ server, gpu }) => idleReservationGpuKey(server.id, gpu.uuid) === key)
        if (!item) continue
        const snapshot = snapshots[item.server.id]
        const freeGpuGb = displayedFreeMemoryGb(item.gpu.memoryTotalMb - item.gpu.memoryUsedMb)
        const freeCpuGb = displayedFreeMemoryGb(((snapshot?.system.memoryTotalBytes ?? 0) - (snapshot?.system.memoryUsedBytes ?? 0)) / 1024 ** 2)
        const location = item.server.location ? `，位置 ${item.server.location}` : ''
        void api.notify(
          `${serverDisplayName(item.server.name)} · GPU ${item.gpu.index} 预约条件已满足`,
          `可用显存 ${freeGpuGb.toFixed(1)} GB，系统内存 ${freeCpuGb.toFixed(1)} GB${location}`,
          { serverId: item.server.id, gpuUuid: item.gpu.uuid, reservationId: reservation.id },
        )
      }
      return evaluation.reservation
    })
    if (!anyChanged) return
    idleReservationsRef.current = nextReservations
    setIdleReservations(nextReservations)
    for (const reservation of changedReservations) {
      void api.saveIdleReservation(reservation).catch((error) => setToast(`预约状态保存失败：${String(error)}`))
    }
  }, [idleFilterHistory, idleHistoryReady, servers, snapshots])

  useEffect(() => {
    const now = Math.max(...Object.values(snapshots).map((snapshot) => snapshot.timestamp), 0)
    const result = deriveGpuMemoryStallWarnings(servers, snapshots, gpuMemoryStallSince.current, ignoredGpuMemoryStallWarningIds, now)
    gpuMemoryStallSince.current = result.since
    localStorage.setItem('racktop.gpuMemoryStallSince.v1', JSON.stringify(result.since))
    setGpuMemoryStallWarnings(result.warnings)
    let ignoredChanged = false
    const retainedIgnoredIds = new Set(ignoredGpuMemoryStallWarningIds)
    for (const id of ignoredGpuMemoryStallWarningIds) {
      if (id in result.since) continue
      retainedIgnoredIds.delete(id)
      ignoredChanged = true
    }
    if (ignoredChanged) {
      setIgnoredGpuMemoryStallWarningIds(retainedIgnoredIds)
      localStorage.setItem('racktop.ignoredGpuMemoryStallWarnings.v1', JSON.stringify([...retainedIgnoredIds]))
    }
    for (const warning of result.warnings) {
      if (notifiedGpuMemoryStalls.current.has(warning.id)) continue
      notifiedGpuMemoryStalls.current.add(warning.id)
      const defunct = warning.defunctProcesses[0]
      void api.notify(
        `${gpuContextName(warning.serverName, warning.gpuIndex, warning.gpuName)} 显存占用预警`,
        defunct
          ? `GPU ${warning.gpuIndex} 的 ${defunct.username}（PID ${defunct.pid}）已成为僵尸进程，仍占用 ${(warning.memoryUsedMb / 1024).toFixed(1)} GB`
          : `GPU ${warning.gpuIndex} 占用 ${(warning.memoryUsedMb / 1024).toFixed(1)} GB，但 UTL 持续为 0`,
        { serverId: warning.serverId, gpuUuid: warning.gpuUuid },
      )
    }
    for (const id of notifiedGpuMemoryStalls.current) {
      if (!(id in result.since)) notifiedGpuMemoryStalls.current.delete(id)
    }
  }, [servers, snapshots, ignoredGpuMemoryStallWarningIds])

  useEffect(() => {
    if (!settings) return
    const reservationPending = new Set(idleReservations.flatMap((reservation) => reservation.pendingConfirmationGpuKeys ?? [])).size
    const processWarnings = mineProcessWarnings.filter((warning) => warning.tone === 'warning').length
    void api.updateTraySummary(settings.menuBarMode, reservationPending, processWarnings)
  }, [idleReservations, mineProcessWarnings, settings])

  const visibleServers = useMemo(() => {
    return servers.filter((server) => serverMatchesSearch(server, snapshots[server.id], search))
  }, [servers, snapshots, search])

  const idleGpuItems = useMemo(() => rankIdleGpuItems(servers, snapshots, idleFilterHistory, idleFilters), [servers, snapshots, idleFilterHistory, idleFilters])
  const projectRecentRunAt = useMemo(() => {
    const recentRunAt: Record<string, number> = {}
    for (const run of loadManagedRuns()) {
      if (!run.projectId) continue
      recentRunAt[run.projectId] = Math.max(recentRunAt[run.projectId] ?? 0, run.startedAt)
    }
    for (const project of projects) {
      const projectRunAt = recentRunAt[project.id]
      if (!projectRunAt) continue
      for (const resourceId of [...project.datasetIds, ...project.modelIds]) recentRunAt[resourceId] = Math.max(recentRunAt[resourceId] ?? 0, projectRunAt)
    }
    return recentRunAt
  }, [mainView, projects])
  const onboardingSteps = useMemo<OnboardingStep[]>(() => {
    const project = projects.find((item) => item.kind === 'project')
    const resources = projects.filter((item) => item.kind === 'dataset' || item.kind === 'model')
    return [
      { id: 'server', title: '添加第一台服务器', description: '连接 SSH 主机并开始采集算力状态。', actionLabel: '添加服务器', completed: servers.length > 0, onAction: () => { setEditingServer(null); setShowServerForm(true) } },
      { id: 'resource', title: '添加数据集或模型', description: '保存可被多个项目复用的长期资源。', actionLabel: '添加资源', completed: resources.length > 0, onAction: () => { setMainView('projects'); setProjectEditor('new') } },
      { id: 'project', title: '添加项目并关联数据集/模型', description: '创建项目并选择运行所需的长期资源。', actionLabel: '添加项目', completed: Boolean(project && (project.datasetIds.length > 0 || project.modelIds.length > 0)), onAction: () => { setMainView('projects'); setProjectEditor(project ?? 'new') } },
      { id: 'profile', title: '创建启动配置', description: '按项目保存命令与可调超参数。', actionLabel: '创建配置', completed: loadLaunchProfiles().length > 0, onAction: () => { setManagedLaunchIntent({ id: crypto.randomUUID(), projectId: project?.id }); setMainView('mine') } },
      { id: 'task', title: '启动第一个任务', description: '选择服务器和 GPU，完成检查后启动。', actionLabel: '启动任务', completed: loadManagedRuns().length > 0, onAction: () => { setManagedLaunchIntent({ id: crypto.randomUUID(), projectId: project?.id }); setMainView('mine') } },
    ]
  }, [mainView, projects, servers.length])
  const idleAvailableCount = idleGpuItems.filter((item) => item.available).length
  const currentIdleReservation = idleReservations.find((reservation) => (reservation.status === 'active' || reservation.status === 'paused') && idleReservationFiltersEqual(reservation.filters, idleFilters))
  const activeIdleReservationCount = idleReservations.filter((reservation) => reservation.status === 'active').length
  const reservationEditorItems = useMemo(() => reservationEditor ? rankIdleGpuItems(servers, snapshots, idleFilterHistory, reservationEditor.filters) : [], [idleFilterHistory, reservationEditor, servers, snapshots])

  const totals = useMemo(() => {
    const values = Object.values(snapshots)
    const gpus = values.flatMap((snapshot) => snapshot.gpus)
    const readableGpus = gpus.filter(isGpuAvailable)
    const online = servers.filter((server) => server.status === 'online' || server.status === 'warning').length
    return {
      online,
      offline: servers.filter((server) => server.status === 'offline').length,
      gpus: gpus.length,
      idle: idleAvailableCount,
      gpuAverage: readableGpus.length ? readableGpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / readableGpus.length : 0,
      cpuAverage: values.length ? values.reduce((sum, snapshot) => sum + clampPercent(snapshot.system.cpuUtilization), 0) / values.length : 0,
      hot: readableGpus.filter((gpu) => gpu.temperatureCelsius > (settings?.temperatureThresholdCelsius ?? 85)).length,
      gpuAnomalies: gpus.filter((gpu) => !isGpuAvailable(gpu)).length,
      latestRefresh: values.length ? Math.max(...values.map((snapshot) => snapshot.timestamp)) : null,
    }
  }, [snapshots, servers, settings, idleAvailableCount])
  const ignoreGpuMemoryStallWarning = useCallback((warning: GpuMemoryStallWarning) => {
    setIgnoredGpuMemoryStallWarningIds((current) => {
      const next = new Set(current).add(warning.id)
      localStorage.setItem('racktop.ignoredGpuMemoryStallWarnings.v1', JSON.stringify([...next]))
      return next
    })
    setGpuMemoryStallWarnings((current) => current.filter((item) => item.id !== warning.id))
    setToast('已忽略此 GPU 的显存占用预警，可在服务器连接页恢复')
  }, [])

  const restoreGpuMemoryStallWarning = useCallback((warningId: string) => {
    setIgnoredGpuMemoryStallWarningIds((current) => {
      const next = new Set(current)
      next.delete(warningId)
      localStorage.setItem('racktop.ignoredGpuMemoryStallWarnings.v1', JSON.stringify([...next]))
      return next
    })
    notifiedGpuMemoryStalls.current.delete(warningId)
    setToast('已恢复显存占用预警')
  }, [])

  async function saveIdleReservation(reservation: IdleReservation) {
    const duplicate = idleReservationsRef.current.find((item) => item.id !== reservation.id && (item.status === 'active' || item.status === 'paused') && idleReservationFiltersEqual(item.filters, reservation.filters))
    if (duplicate) throw new Error(`相同条件的预约“${duplicate.name}”已在监测中`)
    const saved = await api.saveIdleReservation(reservation)
    const next = [saved, ...idleReservationsRef.current.filter((item) => item.id !== saved.id)]
    idleReservationsRef.current = next
    setIdleReservations(next)
    setReservationEditor(null)
    setToast(reservation.id === saved.id && idleReservations.some((item) => item.id === saved.id) ? '预约已更新' : '预约已开始监测')
  }

  async function setIdleReservationStatus(reservation: IdleReservation, status: IdleReservation['status']) {
    const saved = await api.saveIdleReservation({ ...reservation, status })
    const next = idleReservationsRef.current.map((item) => item.id === saved.id ? saved : item)
    idleReservationsRef.current = next
    setIdleReservations(next)
    if (status !== 'active') delete reservationPendingSince.current[reservation.id]
  }

  async function removeIdleReservation(reservationId: string) {
    await api.deleteIdleReservation(reservationId)
    const next = idleReservationsRef.current.filter((item) => item.id !== reservationId)
    idleReservationsRef.current = next
    setIdleReservations(next)
    delete reservationPendingSince.current[reservationId]
  }

  async function clearReservationPending(reservation: IdleReservation) {
    const saved = await api.saveIdleReservation({ ...reservation, pendingConfirmationGpuKeys: [] })
    const next = idleReservationsRef.current.map((item) => item.id === saved.id ? saved : item)
    idleReservationsRef.current = next
    setIdleReservations(next)
    setToast('待确认提示已清除')
  }

  async function saveServer(draft: ServerDraft) {
    const previous = draft.id ? servers.find((item) => item.id === draft.id) : undefined
    const saved = await api.saveServer(draft)
    let sync: RemoteHistorySyncResult | null = null
    if (saved.remoteHistoryEnabled) {
      let configurationError: unknown = null
      for (const delay of [0, 900, 1800]) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
        try {
          await api.configureRemoteHistory(saved.id)
          configurationError = null
          break
        } catch (reason) {
          configurationError = reason
        }
      }
      if (configurationError) {
        setToast(`服务器已保存；远端历史将在连接稳定后重试：${String(configurationError)}`)
      } else {
        try {
          sync = await api.syncRemoteHistory(saved.id)
        } catch (reason) {
          setToast(`服务器已保存，远端历史首次同步失败：${String(reason)}`)
        }
      }
    } else if (previous?.remoteHistoryEnabled) {
      await api.configureRemoteHistory(saved.id)
    }
    const server = sync?.latestTimestamp ? { ...saved, remoteHistoryLastSyncAt: sync.latestTimestamp } : saved
    deletedServerIds.current.delete(saved.id)
    setServers((current) => previous ? current.map((item) => item.id === saved.id ? server : item) : [...current, server])
    setSelectedServerId(saved.id)
    setShowServerForm(false)
    setEditingServer(null)
    await refreshServer(saved.id)
  }

  async function saveProject(draft: ProjectDraft, syncAfterSave: boolean, linkedResources: LinkedProjectResourcePlan[]) {
    const saved = await api.saveProject(draft)
    setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
    setProjectEditor(null)
    const prepareLinkedResources = async () => {
      const prepared: Array<{ project: Project; syncTargetIds: string[] }> = []
      for (const plan of linkedResources.filter((item) => item.syncOnSave)) {
        const resource = projects.find((item) => item.id === plan.resourceId && item.kind === plan.kind)
        if (!resource) continue
        setPreparingProjectIds((current) => new Set(current).add(resource.id))
        try {
          const plannedIds = new Set(plan.targets.map((target) => target.serverId))
          const configured = await api.saveProject({
            id: resource.id,
            name: resource.name,
            kind: resource.kind,
            sourceServerId: resource.sourceServerId,
            sourcePath: resource.sourcePath,
            datasetIds: [],
            modelIds: [],
            targets: [...resource.targets.filter((target) => !plannedIds.has(target.serverId)).map(({ serverId, path }) => ({ serverId, path })), ...plan.targets],
          })
          const inspected = await api.inspectProject(configured.id)
          setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))
          prepared.push({ project: inspected, syncTargetIds: plan.targets.map((target) => target.serverId) })
        } finally {
          setPreparingProjectIds((current) => { const next = new Set(current); next.delete(resource.id); return next })
        }
      }
      return prepared
    }
    if (syncAfterSave) {
      setPreparingProjectIds((current) => new Set(current).add(saved.id))
      setToast(`“${saved.name}”已保存，正在准备同步`)
      try {
        const [inspected, preparedResources] = await Promise.all([api.inspectProject(saved.id), prepareLinkedResources()])
        setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))
        if (!inspected.sourceExists) throw new Error('主目录不存在，无法开始同步')
        const projectTargetTotal = syncableProjectTargets(inspected).length
        const syncing = syncAllProjectTargets(inspected, false)
        setPreparingProjectIds((current) => { const next = new Set(current); next.delete(saved.id); return next })
        const completed = await syncing
        let resourceCompleted = 0
        let resourceTotal = 0
        for (const prepared of preparedResources) {
          resourceTotal += prepared.syncTargetIds.length
          const results = await Promise.all(prepared.syncTargetIds.map((serverId) => syncProjectTarget(prepared.project, serverId, false)))
          resourceCompleted += results.filter(Boolean).length
        }
        const resourceMessage = resourceTotal > 0 ? `；关联资源 ${resourceCompleted} / ${resourceTotal} 个目标同步成功` : ''
        setToast(completed === projectTargetTotal ? `“${saved.name}”已更新 ${completed} 个目标${resourceMessage}` : `“${saved.name}”已保存；${completed} / ${projectTargetTotal} 个目标同步成功${resourceMessage}`)
      } catch (reason) {
        setToast(`“${saved.name}”已保存，准备同步失败：${String(reason)}`)
      } finally {
        setPreparingProjectIds((current) => { const next = new Set(current); next.delete(saved.id); return next })
      }
      return
    }
    setToast(`“${saved.name}”已保存`)
    void api.inspectProject(saved.id).then((inspected) => setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))).catch((reason) => setToast(`“${saved.name}”已保存，路径检测失败：${String(reason)}`))
  }

  async function inspectProject(project: Project) {
    try {
      const inspected = await api.inspectProject(project.id)
      setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))
      setToast(`“${project.name}”路径检测完成`)
    } catch (reason) { setToast(`路径检测失败：${String(reason)}`) }
  }

  async function syncProjectTarget(project: Project, targetServerId: string, showToast = true, force = false) {
    const key = `${project.id}:${targetServerId}`
    if (busyProjectTargets.has(key)) return false
    setBusyProjectTargets((current) => new Set(current).add(key))
    try {
      const result = await api.syncProject(project.id, targetServerId, force)
      setProjects(await api.listProjects())
      if (showToast) setToast(`${result.message} · ${formatDataBytes(result.transferredBytes)}`)
      return true
    } catch (reason) {
      try {
        const refreshedProjects = await api.listProjects()
        setProjects(refreshedProjects)
      } catch { /* Keep the current list when the failure state cannot be reloaded. */ }
      if (showToast) setToast(`同步失败：${String(reason)}`)
      return false
    } finally {
      setBusyProjectTargets((current) => { const next = new Set(current); next.delete(key); return next })
    }
  }

  async function cancelProjectTarget(projectId: string, targetServerId: string) {
    try {
      await api.cancelProjectSync(projectId, targetServerId)
      setToast('正在安全暂停同步')
    } catch (reason) { setToast(`无法暂停同步：${String(reason)}`) }
  }

  async function syncAllProjectTargets(project: Project, showCompletion = true) {
    const targets = syncableProjectTargets(project)
    if (targets.length === 0) {
      if (showCompletion) setToast(`“${project.name}”没有待更新的目标服务器`)
      return 0
    }
    const results = await mapWithConcurrency(targets, 2, (target) => syncProjectTarget(project, target.serverId, false))
    const completed = results.filter(Boolean).length
    if (showCompletion) setToast(completed === targets.length ? `“${project.name}”已更新 ${completed} 个目标` : `“${project.name}”同步完成；${completed} / ${targets.length} 个目标成功`)
    return completed
  }

  async function removeServer(server: Server, revokeSshAccess: boolean) {
    deletedServerIds.current.add(server.id)
    try {
      const deletion = await api.deleteServer(server.id, revokeSshAccess)
      const remainingProjects = await api.listProjects()
      const nextSelectedId = servers.find((item) => item.id !== server.id)?.id ?? null
      setServers((current) => current.filter((item) => item.id !== server.id))
      setProjects(remainingProjects)
      setSelectedServerId((current) => current === server.id ? nextSelectedId : current)
      setSnapshots((current) => {
        const next = { ...current }
        delete next[server.id]
        snapshotsRef.current = next
        return next
      })
      setHistory((current) => {
        const next = { ...current }
        delete next[server.id]
        return next
      })
      setMineProcessWarnings((current) => current.filter((warning) => warning.serverId !== server.id))
      for (const id of ignoredMineProcessWarningsRef.current) if (id.includes(`:${server.id}:`)) ignoredMineProcessWarningsRef.current.delete(id)
      localStorage.setItem('racktop.ignoredMineProcessWarnings.v1', JSON.stringify([...ignoredMineProcessWarningsRef.current]))
      for (const key of sharedGpuWatchesRef.current.keys()) if (key.startsWith(`${server.id}:`)) sharedGpuWatchesRef.current.delete(key)
      delete failureCounts.current[server.id]
      delete lastAttemptAt.current[server.id]
      delete lastProcessAttemptAt.current[server.id]
      delete lastDiskAttemptAt.current[server.id]
      delete lastHistoryRecordedAt.current[server.id]
      delete nextRetryAt.current[server.id]
      for (const key of Object.keys(conditionSince.current)) if (key.includes(`:${server.id}:`)) delete conditionSince.current[key]
      for (const key of notifiedConditions.current) if (key.includes(`:${server.id}:`) || key === `offline:${server.id}`) notifiedConditions.current.delete(key)
      setServerPendingDelete(null)
      setToast(deletion.message)
      if (deletion.cleanupPending) {
        void api.notify(`${serverDisplayName(server.name)} 远端清理等待重连`, '本地记录已删除，远端数据会自动重试清理 24 小时；超过期限将通知手动清理方式。')
      }
    } catch (error) {
      deletedServerIds.current.delete(server.id)
      throw error
    }
  }

  async function importConfig() {
    if (importingConfig) return
    setImportingConfig(true)
    try {
      const drafts = await api.importSshConfig()
      if (drafts.length === 0) {
        setToast('已读取 ~/.ssh/config，但没有找到可导入的 Host；通配符 Host 会被忽略')
        return
      }
      setImportDrafts(drafts)
    } catch (error) {
      setToast(`SSH Config 导入失败：${String(error)}`)
    } finally {
      setImportingConfig(false)
    }
  }

  function previewServerMove(sourceId: string, targetId: string, placement: ServerDropPlacement) {
    if (!sourceId || search) return
    const original = dragOriginalServersRef.current ?? servers
    const current = dragPreviewServersRef.current ?? original
    const next = previewServerOrder(original, sourceId, targetId, placement)
    if (next.map(({ id }) => id).join('\n') === current.map(({ id }) => id).join('\n')) return
    dragPreviewServersRef.current = next
    const drag = dragMouseRef.current
    if (!drag) return
    const originalTop = new Map(drag.rows.map((row) => [row.id, row.top]))
    next.forEach((server, nextIndex) => {
      if (server.id === sourceId) return
      const element = serverRowRefs.current.get(server.id)
      const naturalTop = originalTop.get(server.id)
      const destinationTop = originalTop.get(original[nextIndex]?.id)
      if (!element || naturalTop === undefined || destinationTop === undefined) return
      animateServerRowTransform(element, destinationTop - naturalTop)
    })
  }

  function animateServerRowTransform(element: HTMLButtonElement, translateY: number) {
    const reduceMotion = settings?.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const visualTop = element.getBoundingClientRect().top
    element.getAnimations().forEach((animation) => animation.cancel())
    element.style.transform = translateY ? `translateY(${translateY}px)` : ''
    if (reduceMotion) return
    const delta = visualTop - element.getBoundingClientRect().top
    element.animate(
      [{ transform: `translateY(${translateY + delta}px)` }, { transform: translateY ? `translateY(${translateY}px)` : 'translateY(0)' }],
      { duration: 210, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    )
  }

  function positionDraggedServer() {
    const drag = dragMouseRef.current
    const element = drag ? serverRowRefs.current.get(drag.sourceId) : null
    if (!drag?.active || !element) return
    const naturalTop = drag.rows.find((row) => row.id === drag.sourceId)?.top
    if (naturalTop === undefined) return
    element.getAnimations().forEach((animation) => animation.cancel())
    element.style.transform = `translateY(${drag.pointerY - drag.grabOffsetY - naturalTop}px)`
  }

  function settleServerOrder(ordered: Server[]) {
    const visualTops = new Map(Array.from(serverRowRefs.current, ([id, element]) => [id, element.getBoundingClientRect().top]))
    for (const element of serverRowRefs.current.values()) element.getAnimations().forEach((animation) => animation.cancel())
    flushSync(() => {
      setServers(ordered)
      setDraggedServerId(null)
    })
    draggedServerIdRef.current = null
    const reduceMotion = settings?.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const [id, element] of serverRowRefs.current) {
      element.style.transform = ''
      const visualTop = visualTops.get(id)
      if (reduceMotion || visualTop === undefined) continue
      const delta = visualTop - element.getBoundingClientRect().top
      if (Math.abs(delta) >= 0.5) element.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    }
  }

  function beginServerMouseDrag(event: MouseEvent<HTMLSpanElement>, serverId: string) {
    if (event.button !== 0 || search) return
    event.preventDefault()
    event.stopPropagation()
    dragMouseCleanupRef.current?.()
    const row = event.currentTarget.closest('.server-row') as HTMLButtonElement | null
    if (!row) return
    const rows = servers.map((server) => {
      const bounds = serverRowRefs.current.get(server.id)?.getBoundingClientRect()
      return { id: server.id, top: bounds?.top ?? 0, bottom: bounds?.bottom ?? 0 }
    })
    const drag = { sourceId: serverId, startY: event.clientY, pointerY: event.clientY, grabOffsetY: event.clientY - row.getBoundingClientRect().top, active: false, rows }
    dragMouseRef.current = drag
    dragOriginalServersRef.current = servers
    dragPreviewServersRef.current = servers
    draggedServerIdRef.current = serverId

    const cleanup = () => {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', finish, true)
      window.removeEventListener('blur', cancel)
      document.documentElement.classList.remove('is-server-dragging')
      dragMouseCleanupRef.current = null
    }
    const move = (moveEvent: globalThis.MouseEvent) => {
      if (!drag.active && Math.abs(moveEvent.clientY - drag.startY) < 4) return
      moveEvent.preventDefault()
      drag.pointerY = moveEvent.clientY
      if (!drag.active) {
        drag.active = true
        document.documentElement.classList.add('is-server-dragging')
        setDraggedServerId(drag.sourceId)
      }
      positionDraggedServer()
      const target = serverDropTarget(drag.rows, moveEvent.clientY)
      if (target) previewServerMove(drag.sourceId, target.targetId, target.placement)
    }
    const finish = () => {
      cleanup()
      dragMouseRef.current = null
      if (drag.active) {
        suppressServerClickRef.current = true
        settleServerOrder(dragPreviewServersRef.current ?? dragOriginalServersRef.current ?? servers)
        void commitServerOrder()
      } else {
        dragOriginalServersRef.current = null
        dragPreviewServersRef.current = null
        draggedServerIdRef.current = null
      }
    }
    const cancel = () => {
      cleanup()
      dragMouseRef.current = null
      for (const element of serverRowRefs.current.values()) animateServerRowTransform(element, 0)
      cancelServerOrderPreview()
    }
    dragMouseCleanupRef.current = cleanup
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', finish, true)
    window.addEventListener('blur', cancel)
  }

  async function commitServerOrder() {
    const ordered = dragPreviewServersRef.current ?? servers
    const previousOrder = dragOriginalServersRef.current ?? servers
    setDraggedServerId(null)
    draggedServerIdRef.current = null
    try {
      await api.reorderServers(ordered.map((server) => server.id))
    } catch (error) {
      setServers(previousOrder)
      setToast(`服务器顺序保存失败：${String(error)}`)
    } finally {
      dragOriginalServersRef.current = null
      dragPreviewServersRef.current = null
    }
  }

  function cancelServerOrderPreview() {
    if (dragOriginalServersRef.current) setServers(dragOriginalServersRef.current)
    dragOriginalServersRef.current = null
    dragPreviewServersRef.current = null
    draggedServerIdRef.current = null
    setDraggedServerId(null)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${api.isDesktop ? 'sidebar--desktop' : ''}`}>
        <div className="sidebar__titlebar" onMouseDown={startWindowDrag} onDoubleClick={(event) => void toggleWindowMaximize(event)}>
          <div className="traffic-spacer" aria-hidden="true" />
          <button className="brand" onClick={() => setShowAbout(true)} aria-label="关于 RackTop">
            <span className="brand__mark"><Activity size={18} strokeWidth={2.4} /></span>
            <div><strong>RackTop</strong><small>算力监控</small></div>
          </button>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          <button className={mainView === 'fleet' ? 'is-active' : ''} onClick={() => setMainView('fleet')}><LayoutDashboard size={17} />总览 <span className="nav-count">{totals.gpus}</span></button>
          <button className={mainView === 'idle' ? 'is-active' : ''} onClick={() => setMainView('idle')}><Zap size={17} />空闲算力 <span className="nav-count">{totals.idle}</span></button>
          <button className={mainView === 'mine' ? 'is-active' : ''} onClick={() => setMainView('mine')}><UserRound size={17} />我的进程 <span className="nav-count">{servers.reduce((sum, server) => sum + (snapshots[server.id] ? currentUserProcessCount(snapshots[server.id]) : 0), 0)}</span></button>
          <button className={mainView === 'projects' ? 'is-active' : ''} onClick={() => setMainView('projects')}><FolderGit2 size={17} />我的项目 <span className="nav-count">{projects.length}</span></button>
        </nav>
        <div className="sidebar__section-header"><span>服务器</span><span>{totals.online}/{servers.length}</span></div>
        <div className="search-field"><Search size={14} /><input aria-label="搜索服务器" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13} /></button>}</div>
        <div className="server-list">
          {visibleServers.map((server) => {
            const snapshot = snapshots[server.id]
            return (
              <button
                className={`server-row ${selectedServerId === server.id && mainView === 'server' ? 'is-selected' : ''} ${draggedServerId === server.id ? 'is-dragging' : ''}`}
                key={server.id}
                ref={(element) => { if (element) serverRowRefs.current.set(server.id, element); else serverRowRefs.current.delete(server.id) }}
                onClick={() => { if (suppressServerClickRef.current) { suppressServerClickRef.current = false; return }; setSelectedServerId(server.id); setSelectedGpuUuid(null); setMainView('server') }}
              >
                <span className="server-row__drag" aria-hidden="true" onMouseDown={(event) => beginServerMouseDrag(event, server.id)}><GripVertical size={13} /></span>
                <span className={`server-row__status server-row__status--${server.status}`} />
                <span className="server-row__content">
                  <span className="server-row__title">{server.name || server.host}</span>
                  <span className="server-row__meta">{snapshot ? `${snapshot.gpus.length} GPU ${Math.round(aggregateGpuMemoryPercent(snapshot.gpus))}% · CPU ${Math.round(clampPercent(snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0))}%` : server.name.trim() === server.host.trim() ? (server.status === 'offline' ? '暂时离线 · 可重新连接' : '等待首次采样') : server.host}</span>
                </span>
                {snapshot && currentUserProcessCount(snapshot) > 0 && <span className="own-task-dot" title="有你的任务"><UserRound size={11} /></span>}
                <ChevronRight size={14} className="server-row__chevron" />
              </button>
            )
          })}
          {visibleServers.length === 0 && <p className="empty-copy">没有匹配的服务器</p>}
        </div>
        <div className="sidebar__footer">
          <button onClick={() => { setEditingServer(null); setShowServerForm(true) }}><Plus size={16} />添加服务器</button>
          <button onClick={importConfig} disabled={importingConfig}><Download size={16} />{importingConfig ? '正在读取 SSH Config…' : '导入 SSH Config'}</button>
          <button onClick={() => setShowActivityLog(true)}><ScrollText size={16} />日志</button>
          <button onClick={() => setShowSettings(true)}><Settings size={16} />设置</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar" onMouseDown={startWindowDrag} onDoubleClick={(event) => void toggleWindowMaximize(event)}>
          <div className="topbar__title">
            <p className="eyebrow">{mainView === 'projects' ? '跨服务器文件同步' : mainView === 'idle' ? '资源发现' : mainView === 'mine' ? '当前用户任务' : mainView === 'fleet' ? `${totals.online} / ${servers.length} 台在线` : selectedServer ? selectedServer.host : '所有服务器'}</p>
            <h1>{mainView === 'projects' ? '我的项目' : mainView === 'idle' ? '寻找空闲算力' : mainView === 'mine' ? '我的进程' : mainView === 'fleet' ? '算力总览' : selectedServer ? serverDisplayName(selectedServer.name) : 'RackTop 总览'}</h1>
          </div>
          <div className="topbar__actions">
            {(manualRefreshProgress || (remoteHistoryServerKey && remoteSyncStatus)) && <span className="remote-sync-slot">{manualRefreshProgress ? <span className="remote-sync-status remote-sync-status--syncing" role="status" aria-live="polite"><RefreshCw className={manualRefreshingAll ? 'spin' : ''} size={13} />正在重新连接 · {manualRefreshProgress.completed}/{manualRefreshProgress.total} 台</span> : remoteSyncStatus && <RemoteSyncStatus status={remoteSyncStatus} onOpenFailure={() => {
              const serverId = remoteSyncStatus.failedServerIds[0]
              if (!serverId) return
              setSelectedServerId(serverId)
              setSelectedGpuUuid(null)
              setSelectedTab('connection')
              setMainView('server')
            }} />}</span>}
            <span className={`refresh-label ${paused ? 'is-paused' : ''}`}><Clock3 size={14} />{paused ? '采集已暂停' : mainView === 'server' && selectedServer ? relativeTime(selectedServer.lastSeenAt) : totals.latestRefresh ? relativeTime(totals.latestRefresh) : `${settings?.defaultSamplingIntervalSeconds ?? 2} 秒采样`}</span>
            <button className="button button--secondary" onClick={() => void runManualRefreshAll()} disabled={manualRefreshingAll}><RefreshCw size={16} className={manualRefreshingAll ? 'spin' : ''} />刷新全部</button>
            <button className="icon-button" aria-label="预约与通知" onClick={() => setShowReservationCenter(true)}><Bell size={18} />{(totals.hot > 0 || activeIdleReservationCount > 0 || gpuMemoryStallWarnings.length > 0 || mineProcessWarnings.length > 0) && <span className="notification-dot" />}</button>
            <WindowsWindowControls />
          </div>
        </header>

        <div className="workspace__scroll">
          {shouldShowGuidedEmptyState(mainView, servers.length) ? (
            <EmptyState onboarding={<OnboardingChecklist steps={onboardingSteps} previewStep={onboardingPreviewStep} collapsed={onboardingCollapsed} dismissed={onboardingDismissed} useActualState={onboardingUseActualState} showPreviewControls={!api.isDesktop} onPreviewStepChange={setOnboardingPreviewStep} onCollapsedChange={setOnboardingCollapsed} onDismiss={() => { localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true'); setOnboardingDismissed(true); setToast('已隐藏新手引导，可在“设置 → 通用”中重新显示') }} onUseActualStateChange={setOnboardingUseActualState} />} onAdd={() => { setEditingServer(null); setShowServerForm(true) }} onImport={importConfig} />
          ) : servers.length === 0 ? (
            <EmptyState onAdd={() => { setEditingServer(null); setShowServerForm(true) }} onImport={importConfig} />
          ) : mainView === 'projects' ? (
            <ProjectView projects={projects} recentRunAt={projectRecentRunAt} servers={servers} busyTargets={busyProjectTargets} syncProgress={projectSyncProgress} preparingProjectIds={preparingProjectIds} onAdd={() => setProjectEditor('new')} onLaunch={(project) => { setManagedLaunchIntent({ id: crypto.randomUUID(), projectId: project.id }); setMainView('mine') }} onEdit={setProjectEditor} onDelete={setProjectPendingDelete} onInspect={inspectProject} onSync={(project, targetServerId) => { const target = project.targets.find((item) => item.serverId === targetServerId); if (target?.status === 'conflict') setProjectConflictTarget({ project, targetServerId }); else void syncProjectTarget(project, targetServerId) }} onCancel={(projectId, targetServerId) => void cancelProjectTarget(projectId, targetServerId)} onSyncAll={(project) => void syncAllProjectTargets(project)} />
          ) : mainView === 'idle' ? (
            <IdleGpuView servers={servers} snapshots={snapshots} items={idleGpuItems} filters={idleFilters} currentReservation={currentIdleReservation} onFiltersChange={setIdleFilters} onReserve={() => setReservationEditor({ filters: { ...idleFilters }, reservation: currentIdleReservation })} sortRevision={manualRefreshRevision} onLaunch={(server, gpu) => { setManagedLaunchIntent({ id: crypto.randomUUID(), serverId: server.id, gpuUuid: gpu.uuid }); setMainView('mine') }} onQuickTerminal={(server, gpu) => setQuickTerminal({ server, gpu })} onSelect={(serverId, gpuUuid) => { setSelectedServerId(serverId); setSelectedGpuUuid(gpuUuid); setSelectedTab('gpu'); setMainView('server') }} onReserveGpu={(server, gpu) => setReservationEditor({ filters: { ...idleFilters, duration: 0, targetServerId: server.id, targetGpuUuid: gpu.uuid } })} />
          ) : mainView === 'mine' ? (
            <ManagedProcessView servers={servers} snapshots={snapshots} projects={projects} warnings={mineProcessWarnings} launchIntent={managedLaunchIntent} onLaunchIntentConsumed={() => setManagedLaunchIntent(null)} onDismissWarning={(warningId) => { ignoredMineProcessWarningsRef.current.add(warningId); localStorage.setItem('racktop.ignoredMineProcessWarnings.v1', JSON.stringify([...ignoredMineProcessWarningsRef.current])); setMineProcessWarnings((current) => current.filter((warning) => warning.id !== warningId)) }} onOpenTerminal={(serverId) => { const server = servers.find((item) => item.id === serverId); if (server) setQuickTerminal({ server }) }} onNotice={setToast} onRefreshServer={(serverId) => refreshServer(serverId)} />
          ) : mainView === 'fleet' ? (
            <FleetOverview onboarding={<OnboardingChecklist steps={onboardingSteps} previewStep={onboardingPreviewStep} collapsed={onboardingCollapsed} dismissed={onboardingDismissed} useActualState={onboardingUseActualState} showPreviewControls={!api.isDesktop} onPreviewStepChange={setOnboardingPreviewStep} onCollapsedChange={setOnboardingCollapsed} onDismiss={() => { localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true'); setOnboardingDismissed(true); setToast('已隐藏新手引导，可在“设置 → 通用”中重新显示') }} onUseActualStateChange={setOnboardingUseActualState} />} servers={servers} snapshots={snapshots} settings={settings} totals={totals} sort={fleetSort} descending={fleetDescending} onSort={setFleetSort} onToggleOrder={() => setFleetDescending((value) => !value)} onSelect={(serverId, tab, gpuUuid) => { setSelectedServerId(serverId); setSelectedGpuUuid(gpuUuid ?? null); setSelectedTab(tab); setMainView('server') }} />
          ) : selectedServer && selectedSnapshot && canDisplayServerDetails(selectedServer.status) ? (
            <ServerDetail
              server={selectedServer}
              snapshot={selectedSnapshot}
              points={history[selectedServer.id] ?? []}
              settings={settings}
              tab={selectedTab}
              selectedGpuUuid={selectedGpuUuid}
              onTab={(tab) => { setSelectedTab(tab); if (tab !== 'gpu') setSelectedGpuUuid(null) }}
              onSelectGpu={(gpuUuid) => { setSelectedGpuUuid(gpuUuid); setSelectedTab('gpu') }}
              onRefresh={() => void runManualRefreshServer(selectedServer.id)}
              onDelete={() => setServerPendingDelete(selectedServer)}
              onEdit={() => { setEditingServer(selectedServer); setShowServerForm(true) }}
              onRequestTerminate={(target) => setProcessPendingTermination({ ...target, serverId: selectedServer.id, serverName: selectedServer.name })}
              terminatingPid={terminatingProcess?.serverId === selectedServer.id ? terminatingProcess.pid : undefined}
              nvidiaWarningIgnored={ignoredNvidiaWarnings.has(selectedServer.id)}
              onIgnoreNvidiaWarning={() => setNvidiaWarningIgnored(selectedServer.id, true)}
              onRestoreNvidiaWarning={() => setNvidiaWarningIgnored(selectedServer.id, false)}
              isRefreshing={manualRefreshingServers.has(selectedServer.id)}
              animateCharts={manualRefreshingAll || manualRefreshingServers.has(selectedServer.id)}
              gpuMemoryWarnings={gpuMemoryStallWarnings.filter((warning) => warning.serverId === selectedServer.id)}
              ignoredGpuMemoryStallWarningIds={ignoredGpuMemoryStallWarningIds}
              onRestoreGpuMemoryStallWarning={restoreGpuMemoryStallWarning}
            />
          ) : (
            <LoadingServer server={selectedServer} isRefreshing={selectedServer ? busy.has(selectedServer.id) : false} onRefresh={() => selectedServer && void refreshServer(selectedServer.id)} onDelete={() => selectedServer && setServerPendingDelete(selectedServer)} />
          )}
        </div>
      </main>

      {showServerForm && <ServerForm initial={editingServer ? serverToDraft(editingServer) : undefined} defaultRemoteHistoryEnabled showGuide={settings?.showAddServerGuide ?? true} onGuideDismiss={() => { if (settings) void api.saveSettings({ ...settings, showAddServerGuide: false }).then(setSettings) }} onClose={() => { setShowServerForm(false); setEditingServer(null) }} onSave={saveServer} />}
      {projectEditor && <ProjectForm initial={projectEditor === 'new' ? null : projectEditor} projects={projects} servers={servers} onClose={() => setProjectEditor(null)} onSave={saveProject} />}
      {projectPendingDelete && <ProjectDeleteDialog project={projectPendingDelete} onClose={() => setProjectPendingDelete(null)} onDelete={async () => { await api.deleteProject(projectPendingDelete.id); setProjects((current) => current.filter((item) => item.id !== projectPendingDelete.id)); setProjectPendingDelete(null); setToast(`已移除“${projectPendingDelete.name}”的同步配置，服务器文件未删除`) }} />}
      {projectConflictTarget && <ProjectConflictDialog project={projectConflictTarget.project} server={servers.find((item) => item.id === projectConflictTarget.targetServerId)} onClose={() => setProjectConflictTarget(null)} onConfirm={() => { const pending = projectConflictTarget; setProjectConflictTarget(null); void syncProjectTarget(pending.project, pending.targetServerId, true, true) }} />}
      {showSettings && settings && <SettingsSheet settings={settings} onboardingVisible={!onboardingDismissed} onClose={() => setShowSettings(false)} onSave={async (value, showOnboarding) => { setSettings(await api.saveSettings(value)); if (showOnboarding) { localStorage.removeItem(ONBOARDING_DISMISSED_KEY); setOnboardingDismissed(false); setOnboardingUseActualState(true); setOnboardingCollapsed(false); if (onboardingDismissed) setMainView('fleet') } else { localStorage.setItem(ONBOARDING_DISMISSED_KEY, 'true'); setOnboardingDismissed(true) } setShowSettings(false); setToast('设置已保存') }} />}
      {showActivityLog && <ActivityLogSheet servers={servers} snapshots={snapshots} onClose={() => setShowActivityLog(false)} />}
      {showAbout && <AboutSheet onClose={() => setShowAbout(false)} onNotice={setToast} />}
      {importDrafts && <SshImportSheet drafts={importDrafts} servers={servers} onClose={() => setImportDrafts(null)} onImport={async (selected) => { for (const draft of selected) await api.saveServer(draft); setServers(await api.listServers()); setImportDrafts(null); setToast(`已导入 ${selected.length} 台服务器`) }} />}
      {pendingHostKey && <HostKeyDialog info={pendingHostKey} onClose={() => setPendingHostKey(null)} onTrust={async () => { const serverId = pendingHostKey.serverId; await api.trustHostKey(pendingHostKey); setPendingHostKey(null); setToast('已信任服务器指纹'); await refreshServer(serverId) }} />}
      {serverPendingDelete && <DeleteServerDialog server={serverPendingDelete} onClose={() => setServerPendingDelete(null)} onDelete={(revokeSshAccess) => removeServer(serverPendingDelete, revokeSshAccess)} />}
      {processPendingTermination && <TerminateProcessDialog target={processPendingTermination} onClose={() => setProcessPendingTermination(null)} onTerminate={() => { const target = processPendingTermination; setProcessPendingTermination(null); setTerminatingProcess({ serverId: target.serverId, pid: target.process.pid }); void api.terminateProcess(target.serverId, target.process.pid).then(async (result) => { expectedProcessExitsRef.current.add(`exit:${target.serverId}:${target.process.pid}`); setToast(result); await refreshServer(target.serverId) }).catch((reason) => setToast(`结束 PID ${target.process.pid} 失败：${String(reason)}`)).finally(() => setTerminatingProcess(null)) }} />}
      {reservationEditor && <IdleReservationSheet reservation={reservationEditor.reservation} filters={reservationEditor.filters} availableGpuKeys={reservationEditorItems.filter((item) => item.available).map(({ server, gpu }) => idleReservationGpuKey(server.id, gpu.uuid))} onClose={() => setReservationEditor(null)} onSave={saveIdleReservation} />}
      {showReservationCenter && <IdleReservationCenter reservations={idleReservations} warnings={gpuMemoryStallWarnings} onClose={() => setShowReservationCenter(false)} onEdit={(reservation) => { setShowReservationCenter(false); setReservationEditor({ filters: reservation.filters, reservation }) }} onStatusChange={setIdleReservationStatus} onClearPending={clearReservationPending} onDelete={removeIdleReservation} onIgnoreWarning={ignoreGpuMemoryStallWarning} />}
      {quickTerminal && <div className="scrim quick-terminal-scrim" onMouseDown={(event) => event.target === event.currentTarget && setQuickTerminal(null)}><section className="sheet quick-terminal-sheet" role="dialog" aria-modal="true" aria-label={`${quickTerminal.server.name}${quickTerminal.gpu ? ` GPU ${quickTerminal.gpu.index}` : ''} 终端`}><header className="sheet__header"><div><p className="eyebrow">{quickTerminal.gpu ? 'GPU 固定终端' : 'SSH 终端'}</p><h2>{quickTerminal.server.name}{quickTerminal.gpu ? ` · GPU ${quickTerminal.gpu.index}` : ''}</h2></div><button className="icon-button" onClick={() => setQuickTerminal(null)} aria-label="关闭"><X size={18} /></button></header><SshTerminal serverId={quickTerminal.server.id} serverName={quickTerminal.server.name} gpuIndex={quickTerminal.gpu?.index} onNotice={setToast} /></section></div>}
      {toast && <div className="toast" role="status"><AlertCircle size={17} /><span>{toast}</span><button onClick={() => setToast(null)} aria-label="关闭"><X size={14} /></button></div>}
    </div>
  )
}

export function EmptyState({ onboarding, onAdd, onImport }: { onboarding?: React.ReactNode; onAdd: () => void; onImport: () => void }) {
  return (
    <div className={`empty-fleet${onboarding ? ' empty-fleet--guided' : ''}`}>
      {onboarding}
      <div className="empty-state">
        <span className="empty-state__icon"><ServerIcon size={28} /></span>
        <h2>连接第一台服务器</h2>
        <p>添加 SSH 主机或导入现有 OpenSSH Config，RackTop 会自动采集 GPU、CPU、内存和进程指标。</p>
        <div><button className="button button--primary" onClick={onAdd}><Plus size={17} />添加服务器</button><button className="button button--secondary" onClick={onImport}><Download size={17} />导入配置</button></div>
      </div>
    </div>
  )
}

function LoadingServer({ server, isRefreshing, onRefresh, onDelete }: { server?: Server; isRefreshing: boolean; onRefresh: () => void; onDelete: () => void }) {
  const isConnecting = isRefreshing || server?.status === 'connecting'
  const isOffline = server?.status === 'offline'
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Network size={28} /></span>
      <h2>{isConnecting ? `正在连接 ${server ? serverDisplayName(server.name) : ''}` : isOffline ? `${server ? serverDisplayName(server.name) : '服务器'} 当前离线` : '尚无采样数据'}</h2>
      <p>{server?.lastError ?? '通过 SSH 获取第一份指标后，这里会显示完整服务器详情。'}</p>
      <div className="loading-server__actions"><button className="button button--primary" onClick={onRefresh} disabled={isConnecting}><RefreshCw size={17} className={isConnecting ? 'spin' : ''} />{isConnecting ? '连接中…' : isOffline ? '重新连接' : '立即连接'}</button>{server && <button className="button button--danger" onClick={onDelete}><Trash2 size={16} />删除服务器</button>}</div>
    </div>
  )
}

interface ServerDetailProps {
  server: Server
  snapshot: Snapshot
  points: HistoryPoint[]
  settings: AppSettings | null
  tab: DetailTab
  selectedGpuUuid: string | null
  onTab: (tab: DetailTab) => void
  onSelectGpu: (gpuUuid: string) => void
  onRefresh: () => void
  onDelete: () => void
  onEdit: () => void
  onRequestTerminate: (target: ProcessTerminationTarget) => void
  terminatingPid?: number
  nvidiaWarningIgnored: boolean
  onIgnoreNvidiaWarning: () => void
  onRestoreNvidiaWarning: () => void
  isRefreshing: boolean
  animateCharts: boolean
  gpuMemoryWarnings: GpuMemoryStallWarning[]
  ignoredGpuMemoryStallWarningIds: Set<string>
  onRestoreGpuMemoryStallWarning: (warningId: string) => void
}

function ServerDetail({ server, snapshot, points, settings, tab, selectedGpuUuid, onTab, onSelectGpu, onRefresh, onDelete, onEdit, onRequestTerminate, terminatingPid, nvidiaWarningIgnored, onIgnoreNvidiaWarning, onRestoreNvidiaWarning, isRefreshing, animateCharts, gpuMemoryWarnings, ignoredGpuMemoryStallWarningIds, onRestoreGpuMemoryStallWarning }: ServerDetailProps) {
  const [showLogs, setShowLogs] = useState(false)
  return (
    <div className={`detail-page ${tab === 'terminal' ? 'detail-page--terminal' : ''}`}>
      <div className="server-identity">
        <div><StatusPill status={server.status} /><span className="server-identity__meta">{server.location ? `${server.location} · ` : ''}{snapshot.username}@{snapshot.hostname} · 端口 {server.port}</span></div>
        <div className="server-identity__actions"><button className="icon-button" aria-label="打开采集与连接日志" title="日志" onClick={() => setShowLogs((value) => !value)}><ScrollText size={17} /></button><button className="icon-button" aria-label="编辑服务器" title="编辑服务器" onClick={onEdit}><MoreHorizontal size={18} /></button></div>
      </div>
      {showLogs && <div className="floating-log-panel"><LogsView server={server} snapshot={snapshot} /><button className="icon-button floating-log-panel__close" onClick={() => setShowLogs(false)} aria-label="关闭日志"><X size={15} /></button></div>}
      <div className="detail-tabs" role="tablist">
        {tabs.map((item) => <button key={item.value} role="tab" aria-selected={tab === item.value} className={tab === item.value ? 'is-active' : ''} onClick={() => onTab(item.value)}>{item.label}</button>)}
      </div>
      <div className="detail-content">
        {snapshot.nvidiaSmi !== 'available' && !nvidiaWarningIgnored && <NvidiaWarning snapshot={snapshot} onRefresh={onRefresh} onIgnore={onIgnoreNvidiaWarning} />}
        {tab === 'overview' && <ServerOverview snapshot={snapshot} points={points} idleThreshold={settings?.idleGpuThreshold ?? 10} onSelectGpu={onSelectGpu} onOpenCpu={() => onTab('cpu')} onRequestTerminate={onRequestTerminate} terminatingPid={terminatingPid} animateCharts={animateCharts} gpuMemoryWarnings={gpuMemoryWarnings} />}
        {tab === 'gpu' && <GpuDetail snapshot={snapshot} points={points} selectedGpuUuid={selectedGpuUuid} onSelectGpu={onSelectGpu} animateChart={animateCharts} />}
        {tab === 'cpu' && <CpuDetail snapshot={snapshot} points={points} animateChart={animateCharts} />}
        {tab === 'processes' && <ProcessBlocks snapshot={snapshot} terminatingPid={terminatingPid} onRequestTerminate={onRequestTerminate} />}
        {tab === 'terminal' && <SshTerminal serverId={server.id} serverName={server.name} />}
        {tab === 'history' && <HistoryView server={server} snapshot={snapshot} />}
        {tab === 'connection' && <ConnectionView server={server} snapshot={snapshot} nvidiaWarningIgnored={nvidiaWarningIgnored} ignoredGpuMemoryStallWarningIds={ignoredGpuMemoryStallWarningIds} onRestoreNvidiaWarning={onRestoreNvidiaWarning} onRestoreGpuMemoryStallWarning={onRestoreGpuMemoryStallWarning} onRefresh={onRefresh} onDelete={onDelete} onEdit={onEdit} isRefreshing={isRefreshing} />}
      </div>
    </div>
  )
}

function MetricCard({ icon, label, value, foot, tone, emphasisFoot = false }: { icon: React.ReactNode; label: string; value: string; foot: string; tone: string; emphasisFoot?: boolean }) {
  return <article className="metric-card"><span className={`metric-card__icon metric-card__icon--${tone}`}>{icon}</span><div><span className="metric-card__label">{label}</span><strong>{value}</strong><small className={emphasisFoot ? 'metric-card__own' : ''}>{foot}</small></div></article>
}

function PanelHeader({ icon, title, subtitle, action }: { icon?: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return <header className="panel__header"><div>{icon && <span>{icon}</span>}<div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div></div>{action}</header>
}

type TelemetryItem = {
  label: string
  value: string
  tone?: 'normal' | 'warning' | 'critical'
}

function TelemetryGrid({ items, compact = false }: { items: Array<TelemetryItem | null | false | undefined>; compact?: boolean }) {
  const visibleItems = items.filter(Boolean) as TelemetryItem[]
  if (!visibleItems.length) return null
  return <div className={`resource-telemetry${compact ? ' resource-telemetry--compact' : ''}`}>
    {visibleItems.map((item) => <span className={item.tone && item.tone !== 'normal' ? `is-${item.tone}` : undefined} key={item.label}><small>{item.label}</small><strong title={item.value}>{item.value}</strong></span>)}
  </div>
}

function ServerOverview({ snapshot, points, idleThreshold, onSelectGpu, onOpenCpu, onRequestTerminate, terminatingPid, animateCharts, gpuMemoryWarnings }: { snapshot: Snapshot; points: HistoryPoint[]; idleThreshold: number; onSelectGpu: (gpuUuid: string) => void; onOpenCpu: () => void; onRequestTerminate: (target: ProcessTerminationTarget) => void; terminatingPid?: number; animateCharts: boolean; gpuMemoryWarnings: GpuMemoryStallWarning[] }) {
  const readableGpus = snapshot.gpus.filter(isGpuAvailable)
  const totalMemoryMb = readableGpus.reduce((sum, gpu) => sum + Math.max(0, gpu.memoryTotalMb), 0)
  const usedMemoryMb = readableGpus.reduce((sum, gpu) => sum + Math.max(0, gpu.memoryUsedMb), 0)
  const gpuAverage = readableGpus.length ? readableGpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / readableGpus.length : 0
  const idleCount = snapshot.gpus.filter((gpu) => isGpuIdle(gpu, idleThreshold)).length
  const systemMemoryPercent = snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0
  const modules = {
    metrics: <section className="metric-grid">
      <MetricCard icon={<Zap />} label="可用 GPU" value={`${idleCount} / ${snapshot.gpus.length}`} foot="显存低于 1% 且核心空闲" tone="green" />
      <MetricCard icon={<MemoryStick />} label="GPU 显存" value={`${(usedMemoryMb / 1024).toFixed(1)} GB`} foot={`共 ${(totalMemoryMb / 1024).toFixed(1)} GB`} tone="purple" />
      <MetricCard icon={<Gauge />} label="GPU 平均 UTL" value={`${gpuAverage.toFixed(1)}%`} foot={`${readableGpus.length} 块可读取 · 共 ${snapshot.gpus.length} 块`} tone={gpuLoadAccent(gpuAverage)} />
      <MetricCard icon={<TerminalSquare />} label="当前进程" value={`${snapshot.processes.length + snapshot.cpuProcesses.length} 个进程`} foot={`GPU ${snapshot.processes.length} · CPU ${snapshot.cpuProcesses.length}${[...snapshot.processes, ...snapshot.cpuProcesses].some((process) => process.isCurrentUser) ? ' · 包含你的任务' : ''}`} tone="orange" emphasisFoot={[...snapshot.processes, ...snapshot.cpuProcesses].some((process) => process.isCurrentUser)} />
    </section>,
    resources: <section className="overview-section" aria-labelledby="overview-resource-title">
      <div className="overview-section__header"><Gauge size={17} /><div><h2 id="overview-resource-title">GPU 与 CPU 状态</h2><p>GPU 显存优先，CPU 资源并列概览</p></div></div>
      <div className="gpu-grid">{snapshot.gpus.map((gpu) => <GpuCard key={gpu.uuid} gpu={gpu} processes={snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid)} warning={gpuMemoryWarnings.find((warning) => warning.gpuUuid === gpu.uuid)} onOpen={() => onSelectGpu(gpu.uuid)} />)}<CpuOverviewCard snapshot={snapshot} memoryPercent={systemMemoryPercent} onOpen={onOpenCpu} /></div>
    </section>,
    trends: <section className="overview-section" aria-labelledby="overview-trends-title">
      <div className="overview-section__header"><Activity size={17} /><div><h2 id="overview-trends-title">实时趋势</h2><p>CPU、GPU 显存、系统内存与 Swap、GPU 核心利用率</p></div></div>
      <div className="trend-grid">
        <section className="panel panel--mini-chart"><PanelHeader title="CPU UTL" /><TrendChart points={points} snapshot={snapshot} mode="cpu" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="GPU MEM" /><TrendChart points={points} snapshot={snapshot} mode="gpuMemory" height={170} animate={animateCharts} seriesOpacity={0.9} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="系统 MEM / SWP" /><TrendChart points={points} snapshot={snapshot} mode="systemMemory" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="GPU UTL" /><TrendChart points={points} snapshot={snapshot} mode="gpu" height={170} animate={animateCharts} seriesOpacity={0.9} /></section>
      </div>
    </section>,
    processes: <ProcessBlocks snapshot={snapshot} compact currentLabels terminatingPid={terminatingPid} onRequestTerminate={onRequestTerminate} />,
  }

  return <div className="overview-stack">{modules.metrics}{modules.resources}{modules.processes}{modules.trends}</div>
}

function GpuCard({ gpu, processes, warning, onOpen }: { gpu: Snapshot['gpus'][number]; processes: Snapshot['processes']; warning?: GpuMemoryStallWarning; onOpen: () => void }) {
  const [showWarning, setShowWarning] = useState(false)
  const warningButtonRef = useRef<HTMLButtonElement>(null)
  const closeWarning = () => {
    setShowWarning(false)
    requestAnimationFrame(() => warningButtonRef.current?.focus())
  }
  if (!isGpuAvailable(gpu)) return (
    <button className="panel gpu-card gpu-card--unavailable" onClick={onOpen}>
      <PanelHeader title={`GPU ${gpu.index}`} subtitle={gpu.name.replace('Unavailable GPU ', '')} action={<ChevronRight size={16} />} />
      <div className="gpu-unavailable"><AlertCircle size={19} /><div><strong>无法读取</strong><p>此显卡当前未返回监控数据，不计入空闲算力或预约。</p></div></div>
    </button>
  )
  const memoryPercent = gpuMemoryPercent(gpu)
  const displayedMemoryPercent = displayedGpuMemoryPercent(memoryPercent)
  const memoryLevel = gpuMemoryLevel(memoryPercent)
  const ownMemoryMb = processes.filter((process) => process.isCurrentUser).reduce((sum, process) => sum + process.memoryUsedMb, 0)
  const ownMemoryPercent = gpu.memoryTotalMb ? ownMemoryMb / gpu.memoryTotalMb * 100 : 0
  const totalSmUtilization = aggregateGpuSmUtilization(processes)
  return (
    <article className={`panel gpu-card gpu-card--${memoryLevel}${warning ? ' gpu-card--warning' : ''}`}>
      <button type="button" className="gpu-card__open" onClick={onOpen} aria-label={`查看 GPU ${gpu.index} 详情`} />
      <PanelHeader title={`GPU ${gpu.index}`} subtitle={gpu.name.replace('NVIDIA ', '')} action={<span className="gpu-card__header-actions">{warning && <button ref={warningButtonRef} type="button" className="gpu-card__warning" aria-label={`查看 GPU ${gpu.index} 异常详情`} title="查看具体问题" onClick={() => setShowWarning(true)}><AlertCircle size={17} /></button>}<ChevronRight size={16} aria-hidden="true" /></span>} />
      <MetricBar label="MEM" value={displayedMemoryPercent} detail={`${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(0)} GB`} accent="purple" currentUserValue={ownMemoryPercent} currentUserDetail={`${(ownMemoryMb / 1024).toFixed(1)} GB`} />
      <MetricBar label="UTL" value={clampPercent(gpu.utilization)} accent={gpuLoadAccent(gpu.utilization)} />
      <TelemetryGrid compact items={[
        { label: '可用显存', value: `${(Math.max(0, gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} GB` },
        { label: 'MBW', value: `${clampPercent(gpu.memoryUtilization).toFixed(0)}%` },
        { label: 'SM', value: `${totalSmUtilization.toFixed(0)}%` },
        { label: '功率 / 上限', value: gpu.powerLimitWatts ? `${gpu.powerWatts.toFixed(0)} / ${gpu.powerLimitWatts.toFixed(0)} W` : `${gpu.powerWatts.toFixed(0)} W` },
        { label: '温度', value: `${gpu.temperatureCelsius}°C` },
        Boolean(gpu.performanceState) && { label: 'P-State', value: gpu.performanceState! },
        gpu.smClockMhz !== undefined && gpu.smClockMhz > 0 && { label: 'SM 频率', value: formatClock(gpu.smClockMhz) },
        { label: '进程', value: `${processes.length} 个` },
      ]} />
      {showWarning && warning && <GpuMemoryWarningDialog warning={warning} onClose={closeWarning} />}
    </article>
  )
}

function GpuMemoryWarningDialog({ warning, onClose }: { warning: GpuMemoryStallWarning; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
  const durationHours = Math.floor(warning.durationSeconds / 3600)
  const durationMinutes = Math.max(1, Math.floor(warning.durationSeconds / 60))
  const duration = durationHours > 0 ? `${durationHours} 小时` : `${durationMinutes} 分钟`
  const hasDefunctProcesses = warning.defunctProcesses.length > 0
  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet gpu-warning-sheet" role="dialog" aria-modal="true" aria-labelledby="gpu-warning-title">
        <header className="sheet__header"><div><p className="eyebrow">GPU 异常</p><h2 id="gpu-warning-title">{gpuContextName(warning.serverName, warning.gpuIndex, warning.gpuName)}</h2></div><button autoFocus className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="gpu-warning-body">
          <span className="gpu-warning-body__icon"><AlertCircle size={23} /></span>
          <div><strong>{hasDefunctProcesses ? '检测到僵尸进程占用显存' : '显存持续占用，但 GPU 利用率为 0'}</strong><p>{hasDefunctProcesses ? '进程已经退出但仍残留显存占用，建议检查并清理对应父进程。' : '任务可能正在等待数据、排队或已经停止计算，请核对进程状态。'}</p></div>
          <dl>
            <div><dt>GPU</dt><dd>{warning.gpuName.replace('NVIDIA ', '')}</dd></div>
            <div><dt>显存</dt><dd>{(warning.memoryUsedMb / 1024).toFixed(1)} / {(warning.memoryTotalMb / 1024).toFixed(1)} GB</dd></div>
            <div><dt>持续时间</dt><dd>{duration}</dd></div>
            <div><dt>涉及用户</dt><dd>{warning.usernames.length ? warning.usernames.join('、') : '未识别'}</dd></div>
          </dl>
          {hasDefunctProcesses && <div className="gpu-warning-processes"><strong>僵尸进程</strong>{warning.defunctProcesses.map((process) => <span key={process.pid}><code>PID {process.pid}</code><small>{process.username}</small></span>)}</div>}
        </div>
        <footer className="sheet__footer"><button className="button button--primary" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  )
}

function CpuOverviewCard({ snapshot, memoryPercent, onOpen }: { snapshot: Snapshot; memoryPercent: number; onOpen: () => void }) {
  const logicalCores = snapshot.system.cpuLogicalCores
  const normalizedLoad = logicalCores ? snapshot.system.load1 / logicalCores * 100 : null
  return (
    <button className="panel gpu-card cpu-overview-card" onClick={onOpen}>
      <PanelHeader title="CPU" subtitle={snapshot.system.cpuModel || 'CPU'} action={<ChevronRight size={16} />} />
      <MetricBar label="系统 MEM" value={memoryPercent} detail={`${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`} accent="purple" />
      <MetricBar label="CPU UTL" value={snapshot.system.cpuUtilization} currentUserValue={snapshot.system.currentUserCpuUtilization} currentUserDetail={`${snapshot.system.currentUserCpuUtilization.toFixed(1)}%`} />
      <TelemetryGrid compact items={[
        snapshot.system.memoryAvailableBytes !== undefined && { label: '可用内存', value: formatBytes(snapshot.system.memoryAvailableBytes) },
        { label: '负载 / 线程', value: normalizedLoad === null ? snapshot.system.load1.toFixed(2) : `${normalizedLoad.toFixed(1)}%` },
        snapshot.system.cpuPhysicalCores !== undefined && snapshot.system.cpuPhysicalCores > 0 && snapshot.system.cpuLogicalCores !== undefined && snapshot.system.cpuLogicalCores > 0 && { label: '核心 / 线程', value: `${snapshot.system.cpuPhysicalCores} / ${snapshot.system.cpuLogicalCores}` },
        snapshot.system.cpuFrequencyMhz !== undefined && snapshot.system.cpuFrequencyMhz > 0 && { label: '频率 / 上限', value: snapshot.system.cpuMaxFrequencyMhz ? `${formatClock(snapshot.system.cpuFrequencyMhz)} / ${formatClock(snapshot.system.cpuMaxFrequencyMhz)}` : formatClock(snapshot.system.cpuFrequencyMhz) },
        snapshot.system.cpuUserPercent !== undefined && { label: 'User', value: `${snapshot.system.cpuUserPercent.toFixed(1)}%` },
        snapshot.system.cpuSystemPercent !== undefined && { label: 'System', value: `${snapshot.system.cpuSystemPercent.toFixed(1)}%` },
        snapshot.system.cpuIoWaitPercent !== undefined && { label: 'IO Wait', value: `${snapshot.system.cpuIoWaitPercent.toFixed(1)}%`, tone: snapshot.system.cpuIoWaitPercent >= 10 ? 'warning' : 'normal' },
        { label: 'Swap', value: formatBytes(snapshot.system.swapUsedBytes) },
      ]} />
    </button>
  )
}

function GpuDetail({ snapshot, points, selectedGpuUuid, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; selectedGpuUuid: string | null; onSelectGpu: (gpuUuid: string) => void; animateChart: boolean }) {
  const orderedGpus = snapshot.gpus
  const [expanded, setExpanded] = useState<{ uuid: string; mode: 'sm' | 'processes' } | null>(() => selectedGpuUuid ? { uuid: selectedGpuUuid, mode: 'sm' } : null)
  useEffect(() => { if (selectedGpuUuid) setExpanded({ uuid: selectedGpuUuid, mode: 'sm' }) }, [selectedGpuUuid])
  const toggleExpanded = (uuid: string, mode: 'sm' | 'processes') => setExpanded((current) => current?.uuid === uuid && current.mode === mode ? null : { uuid, mode })
  return <div className="content-stack">
    <section className="resource-trend-grid">{orderedGpus.filter(isGpuAvailable).map((gpu) => <ResourceTrend key={gpu.uuid} snapshot={snapshot} kind="gpu" gpuUuid={gpu.uuid} title={`GPU ${gpu.index} · ${gpu.name.replace('NVIDIA ', '')}`} animate={animateChart} />)}</section>
    <section className="gpu-detail-list">{orderedGpus.map((gpu) => {
      if (!isGpuAvailable(gpu)) return <article className="panel gpu-detail gpu-detail--unavailable" key={gpu.uuid}><div className="gpu-detail__title"><div><span>GPU {gpu.index}</span><h3>{gpu.name}</h3><small>{gpu.uuid.replace('unavailable-', '').replaceAll('_', ':')}</small></div><strong>无法读取</strong></div><div className="gpu-unavailable"><AlertCircle size={19} /><div><strong>监控数据不可用</strong><p>健康 GPU 仍会继续采集；此卡不参与利用率汇总、空闲判断和预约。</p></div></div></article>
      const gpuProcesses = snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid)
      const attributedMemoryMb = gpuProcesses.reduce((sum, process) => sum + Math.max(0, process.memoryUsedMb), 0)
      const unattributedMemoryMb = Math.max(0, gpu.memoryUsedMb - attributedMemoryMb)
      const hasUnattributedMemory = unattributedMemoryMb >= 256
      const ownMemoryMb = gpuProcesses.filter((process) => process.isCurrentUser).reduce((sum, process) => sum + process.memoryUsedMb, 0)
      const totalSmUtilization = aggregateGpuSmUtilization(gpuProcesses)
      const memory = gpuMemoryPercent(gpu)
      const isExpanded = expanded?.uuid === gpu.uuid
      return <article className={`panel gpu-detail gpu-detail--${gpuMemoryLevel(memory)} ${isExpanded ? 'is-selected' : ''}`} key={gpu.uuid}>
        <div className="gpu-detail__title"><div><span>GPU {gpu.index}{isExpanded ? ' · 已展开' : ''}</span><h3>{gpu.name}</h3><small>{gpu.uuid}</small></div><strong>{displayedGpuMemoryPercent(memory)}%<small> MEM</small></strong></div>
        <div className="gpu-detail__meters"><MetricBar label="MEM" value={displayedGpuMemoryPercent(memory)} detail={`${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB`} accent="purple" /><MetricBar label="UTL" value={gpu.utilization} accent={gpuLoadAccent(gpu.utilization)} /></div>
        <div className="stat-row stat-row--gpu"><span><small>MBW</small><strong>{clampPercent(gpu.memoryUtilization).toFixed(0)}%</strong></span><span><small>温度</small><strong>{gpu.temperatureCelsius}°C</strong></span><span><small>功耗</small><strong>{gpu.powerWatts.toFixed(1)} W</strong></span><button type="button" className={expanded?.uuid === gpu.uuid && expanded.mode === 'processes' ? 'is-active' : ''} aria-expanded={expanded?.uuid === gpu.uuid && expanded.mode === 'processes'} onClick={() => toggleExpanded(gpu.uuid, 'processes')}><small>进程</small><strong>{gpuProcesses.length}</strong></button><button type="button" className={expanded?.uuid === gpu.uuid && expanded.mode === 'sm' ? 'is-active' : ''} aria-expanded={expanded?.uuid === gpu.uuid && expanded.mode === 'sm'} onClick={() => toggleExpanded(gpu.uuid, 'sm')}><small>SM</small><strong>{totalSmUtilization.toFixed(0)}%</strong></button></div>
        <TelemetryGrid items={[
          { label: '可用显存', value: `${(Math.max(0, gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} GB` },
          gpu.powerLimitWatts !== undefined && gpu.powerLimitWatts > 0 && { label: '功率上限', value: `${gpu.powerLimitWatts.toFixed(0)} W` },
          gpu.smClockMhz !== undefined && gpu.smClockMhz > 0 && { label: 'SM 频率', value: formatClock(gpu.smClockMhz) },
          gpu.memoryClockMhz !== undefined && gpu.memoryClockMhz > 0 && { label: '显存频率', value: formatClock(gpu.memoryClockMhz) },
          Boolean(gpu.performanceState) && { label: 'P-State', value: gpu.performanceState! },
          gpu.fanSpeedPercent !== undefined && { label: '风扇', value: `${gpu.fanSpeedPercent.toFixed(0)}%` },
          Boolean(gpu.throttleReason) && { label: '限频状态', value: gpu.throttleReason!, tone: gpu.throttleReason === '正常' || gpu.throttleReason === '空闲' ? 'normal' : 'warning' },
          gpu.eccErrors !== undefined && { label: 'ECC 错误', value: `${gpu.eccErrors}`, tone: gpu.eccErrors > 0 ? 'critical' : 'normal' },
        ]} />
        {isExpanded && <div className="gpu-detail__processes"><header><strong>{expanded.mode === 'sm' ? '进程 SM 活跃率' : `GPU ${gpu.index} 进程`}</strong><small>{expanded.mode === 'sm' ? '单次 pmon 采样，不代表算法效率' : `${gpuProcesses.length} 个计算进程`}</small></header>{gpuProcesses.length ? gpuProcesses.map((process) => <div key={process.pid}><code>PID {process.pid}</code><span title={process.command}>{process.command}</span><strong>{expanded.mode === 'sm' ? `SM ${clampPercent(process.smUtilization ?? 0).toFixed(0)}%` : `${(process.memoryUsedMb / 1024).toFixed(1)} GB`}</strong></div>) : <p className="gpu-detail__empty">{hasUnattributedMemory ? `检测到 ${(unattributedMemoryMb / 1024).toFixed(1)} GB 显存占用，但 NVIDIA 驱动未返回可映射的 PID` : '当前没有 GPU 计算进程'}</p>}</div>}
        {ownMemoryMb > 0 && <div className="gpu-detail__own"><UserRound size={13} /><strong>你的任务</strong><span>占用 {(ownMemoryMb / 1024).toFixed(1)} GB 显存</span></div>}
      </article>
    })}</section>
  </div>
}

function CpuDetail({ snapshot, points, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; animateChart: boolean }) {
  const memoryPercent = snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0
  return <div className="content-stack"><ResourceTrend snapshot={snapshot} kind="cpu" title={snapshot.system.cpuModel || 'CPU'} animate={animateChart} /><section className="panel system-resource-panel"><PanelHeader icon={<MemoryStick />} title="系统资源" /><div className="resource-bars"><MetricBar label="CPU" value={snapshot.system.cpuUtilization} currentUserValue={snapshot.system.currentUserCpuUtilization} currentUserDetail={`${snapshot.system.currentUserCpuUtilization.toFixed(1)}%`} /><MetricBar label="内存" value={memoryPercent} detail={`${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`} accent="purple" /></div><div className="stat-row stat-row--border"><span><small>1 分钟负载</small><strong>{snapshot.system.load1.toFixed(2)}</strong></span><span><small>5 分钟负载</small><strong>{snapshot.system.load5.toFixed(2)}</strong></span><span><small>15 分钟负载</small><strong>{snapshot.system.load15.toFixed(2)}</strong></span><span><small>Swap</small><strong>{formatBytes(snapshot.system.swapUsedBytes)}</strong></span></div><TelemetryGrid items={[
    snapshot.system.cpuPhysicalCores !== undefined && snapshot.system.cpuPhysicalCores > 0 && snapshot.system.cpuLogicalCores !== undefined && snapshot.system.cpuLogicalCores > 0 && { label: '核心 / 线程', value: `${snapshot.system.cpuPhysicalCores} / ${snapshot.system.cpuLogicalCores}` },
    snapshot.system.cpuFrequencyMhz !== undefined && snapshot.system.cpuFrequencyMhz > 0 && { label: '当前频率', value: formatClock(snapshot.system.cpuFrequencyMhz) },
    snapshot.system.cpuMaxFrequencyMhz !== undefined && snapshot.system.cpuMaxFrequencyMhz > 0 && { label: '最高频率', value: formatClock(snapshot.system.cpuMaxFrequencyMhz) },
    snapshot.system.cpuUserPercent !== undefined && { label: 'User', value: `${snapshot.system.cpuUserPercent.toFixed(1)}%` },
    snapshot.system.cpuSystemPercent !== undefined && { label: 'System', value: `${snapshot.system.cpuSystemPercent.toFixed(1)}%` },
    snapshot.system.cpuIoWaitPercent !== undefined && { label: 'IO Wait', value: `${snapshot.system.cpuIoWaitPercent.toFixed(1)}%`, tone: snapshot.system.cpuIoWaitPercent >= 10 ? 'warning' : 'normal' },
    snapshot.system.cpuStealPercent !== undefined && { label: 'Steal', value: `${snapshot.system.cpuStealPercent.toFixed(1)}%`, tone: snapshot.system.cpuStealPercent >= 5 ? 'warning' : 'normal' },
    snapshot.system.memoryAvailableBytes !== undefined && { label: '可用内存', value: formatBytes(snapshot.system.memoryAvailableBytes) },
    snapshot.system.memoryCacheBytes !== undefined && { label: '缓存', value: formatBytes(snapshot.system.memoryCacheBytes) },
    snapshot.system.cpuTemperatureCelsius !== undefined && { label: 'CPU 温度', value: `${snapshot.system.cpuTemperatureCelsius.toFixed(0)}°C`, tone: snapshot.system.cpuTemperatureCelsius >= 85 ? 'critical' : snapshot.system.cpuTemperatureCelsius >= 75 ? 'warning' : 'normal' },
  ]} /></section></div>
}

function HistoryView({ server, snapshot }: { server: Server; snapshot: Snapshot }) {
  const [usageDays, setUsageDays] = useState<7 | 15 | 30 | 90>(30)
  const [usage, setUsage] = useState<import('./types/models').UsageDistribution | null>(null)
  const [heatmapPoints, setHeatmapPoints] = useState<HistoryHeatmapPoint[]>([])
  const [heatmapError, setHeatmapError] = useState<string | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const gpuUuidKey = snapshot.gpus.map((gpu) => gpu.uuid).join('\n')

  useEffect(() => {
    let cancelled = false
    const firstDay = new Date(snapshot.timestamp * 1000)
    firstDay.setHours(0, 0, 0, 0)
    firstDay.setDate(firstDay.getDate() - Math.min(90, Math.max(1, server.historyRetentionDays)) + 1)
    const timezoneOffsetSeconds = -new Date().getTimezoneOffset() * 60
    setHeatmapPoints([])
    setHeatmapError(null)
    const loadHeatmap = () => api.getHistoryHeatmap(server.id, Math.floor(firstDay.getTime() / 1000), timezoneOffsetSeconds, snapshot.gpus.map((gpu) => gpu.uuid))
      .then((points) => { if (!cancelled) { setHeatmapPoints(points); setHeatmapError(null) } })
      .catch((historyError) => { if (!cancelled) setHeatmapError(String(historyError)) })
    void loadHeatmap()
    const interval = window.setInterval(() => { void loadHeatmap() }, 60_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [gpuUuidKey, server.historyRetentionDays, server.id])

  useEffect(() => {
    let cancelled = false
    setUsage(null)
    setUsageError(null)
    const loadUsage = () => {
      const from = Math.floor(Date.now() / 1000) - usageDays * 86_400
      void api.getUsageDistribution(server.id, from, usageDays)
        .then((value) => { if (!cancelled) { setUsage(value); setUsageError(null) } })
        .catch((reason) => { if (!cancelled) setUsageError(String(reason)) })
    }
    loadUsage()
    const interval = window.setInterval(loadUsage, 60_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [server.id, usageDays])

  const displayedUsage = usage ?? { users: [], coveredDays: 0, requestedDays: usageDays, coverageGpuSeconds: 0 }

  return <div className="history-page">
    <section className="history-section"><header className="history-page__header"><div><History size={18} /><span><h2>资源热力图</h2><p>每列 1 天，每格汇总连续 3 小时的平均使用率</p></span></div><small>最近 {Math.min(90, Math.max(1, server.historyRetentionDays))} 天</small></header>{heatmapError ? <div className="history-page__state history-page__state--error"><AlertCircle size={16} />资源历史读取失败：{heatmapError}</div> : <HistoryHeatmaps snapshot={snapshot} points={heatmapPoints} retentionDays={server.historyRetentionDays} />}</section>
    <section className="history-section"><header className="history-page__header"><div><History size={18} /><span><h2>GPU 使用分布</h2><p>按 Unix 用户聚合活跃时间与显存积分</p></span></div><div className="usage-range" aria-label="使用分布时间范围">{([7, 15, 30, 90] as const).map((days) => <button key={days} aria-pressed={usageDays === days} onClick={() => setUsageDays(days)}>{days === 7 ? '1 周' : days === 15 ? '半个月' : days === 30 ? '1 个月' : '3 个月'}</button>)}</div></header>{usageError ? <div className="history-page__state history-page__state--error"><AlertCircle size={16} />使用分布读取失败：{usageError}</div> : <UsageDistribution snapshot={snapshot} data={displayedUsage} />}</section>
    <section className="history-section"><header className="history-page__header"><div><HardDrive size={18} /><span><h2>存储空间</h2><p>服务器磁盘占用情况，区分当前用户、其他用户与空闲空间</p></span></div></header><StorageWaffleList disks={snapshot.disks ?? []} /></section>
    <section className="data-retention"><Database size={18} /><div><strong>{server.remoteHistoryEnabled ? '在线本地采样 · 离线远端补档' : '仅在线本地采样'}</strong><p>{server.remoteHistoryEnabled ? 'RackTop 在线时写入本机时间桶；远端隐藏进程仅在 App 离线后接管，重新打开时增量补齐缺口。' : 'RackTop 运行时在本机生成使用分布；App 离线期间不补零，缺失时段保持灰色。'}不会保存 PID、进程命令、路径或终端输入输出。</p></div></section>
  </div>
}

function LogsView({ server, snapshot }: { server: Server; snapshot: Snapshot }) {
  const items = [{ level: 'success', time: snapshot.timestamp, message: `采集成功：${snapshot.gpus.length} GPU，${snapshot.processes.length} 个 GPU 进程，${snapshot.cpuProcesses.length} 个 CPU 进程` }, ...(server.lastError ? [{ level: 'error', time: snapshot.timestamp, message: server.lastError }] : [])]
  return <section className="panel logs-panel"><PanelHeader icon={<ListFilter />} title="采集与连接日志" subtitle={`${items.length} 条最近记录`} /><div className="log-list">{items.map((item, index) => <div className={`log-row log-row--${item.level}`} key={index}><span aria-hidden="true" /><time dateTime={new Date(item.time * 1000).toISOString()}>{new Date(item.time * 1000).toLocaleTimeString()}</time><p>{item.message}</p></div>)}</div></section>
}

function ConnectionView({ server, snapshot, nvidiaWarningIgnored, ignoredGpuMemoryStallWarningIds, onRestoreNvidiaWarning, onRestoreGpuMemoryStallWarning, onRefresh, onDelete, onEdit, isRefreshing }: { server: Server; snapshot: Snapshot; nvidiaWarningIgnored: boolean; ignoredGpuMemoryStallWarningIds: Set<string>; onRestoreNvidiaWarning: () => void; onRestoreGpuMemoryStallWarning: (warningId: string) => void; onRefresh: () => void; onDelete: () => void; onEdit: () => void; isRefreshing: boolean }) {
  const canRestoreNvidiaWarning = nvidiaWarningIgnored && snapshot.nvidiaSmi !== 'available'
  const ignoredMemoryWarnings = ignoredGpuMemoryStallGpus(server.id, snapshot, ignoredGpuMemoryStallWarningIds)
  const ignoredCount = ignoredMemoryWarnings.length + (canRestoreNvidiaWarning ? 1 : 0)
  return <div className="content-stack"><section className="panel connection-panel"><PanelHeader icon={<KeyRound />} title="SSH 连接" subtitle="认证信息仅在本机使用" /><dl className="definition-list"><div><dt>物理位置</dt><dd>{server.location || '未填写'}</dd></div><div><dt>连接地址</dt><dd className="mono">{server.username}@{server.host}:{server.port}</dd></div><div><dt>认证</dt><dd>{isRackTopManagedIdentity(server.identityFile) ? 'RackTop 专用密钥' : server.authMethod === 'sshAgent' ? 'SSH Agent / 默认密钥' : server.authMethod === 'privateKey' ? '指定私钥' : server.authMethod === 'sshConfig' ? 'SSH Config' : '系统钥匙串密码'}</dd></div><div><dt>SSH Config</dt><dd>{server.sshAlias || '未使用别名'}</dd></div><div><dt>私钥</dt><dd className="mono">{server.identityFile || '由 OpenSSH 自动选择'}</dd></div><div><dt>ProxyJump</dt><dd className="mono">{server.proxyJump || '无'}</dd></div><div><dt>远端历史</dt><dd>{server.remoteHistoryEnabled ? `已启用 · ${server.remoteHistoryLastSyncAt ? `同步于 ${relativeTime(server.remoteHistoryLastSyncAt)}` : '等待首次同步'}` : '未启用'}</dd></div></dl><div className="panel__actions"><button className="button button--primary" onClick={onRefresh} disabled={isRefreshing}><RefreshCw size={16} className={isRefreshing ? 'spin' : ''} />测试并重新连接</button><button className="button button--secondary" onClick={onEdit}><Settings size={16} />编辑配置</button></div></section>{ignoredCount > 0 && <section className="panel ignored-warning-list"><PanelHeader icon={<BellOff />} title="已忽略的 GPU 提醒" subtitle={`${ignoredCount} 项提醒仅在此处保留`} /><div>{canRestoreNvidiaWarning && <div className="ignored-warning-row"><div><strong>GPU 读取异常</strong><p>不可读取的显卡仍会显示，但服务器状态暂按在线处理。</p></div><button className="button button--secondary button--small" onClick={onRestoreNvidiaWarning}><Bell size={14} />恢复提醒</button></div>}{ignoredMemoryWarnings.map((gpu) => <div className="ignored-warning-row" key={gpu.uuid}><div><strong>GPU {gpu.index} · {gpu.name.replace(/^NVIDIA\s+/i, '')} 显存占用预警</strong><p>当前占用 {(gpu.memoryUsedMb / 1024).toFixed(1)} / {(gpu.memoryTotalMb / 1024).toFixed(1)} GB，UTL {clampPercent(gpu.utilization).toFixed(0)}%。</p></div><button className="button button--secondary button--small" onClick={() => onRestoreGpuMemoryStallWarning(`gpu-memory-stall:${server.id}:${gpu.uuid}`)}><Bell size={14} />恢复提醒</button></div>)}</div></section>}<section className="panel danger-zone"><div><strong>删除服务器</strong><p>删除本机记录、历史数据、远端采集进程和服务器用户目录中的 RackTop 数据。</p></div><button className="button button--danger" onClick={onDelete}><Trash2 size={16} />删除</button></section></div>
}

function NvidiaWarning({ snapshot, onRefresh, onIgnore }: { snapshot: Snapshot; onRefresh: () => void; onIgnore: () => void }) {
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const command = snapshot.osId === 'ubuntu' ? 'sudo apt update && sudo apt install -y ubuntu-drivers-common && sudo ubuntu-drivers autoinstall' : snapshot.osId === 'debian' ? 'sudo apt update && sudo apt install -y nvidia-driver' : 'command -v nvidia-smi || echo "请参考 NVIDIA 官方驱动文档安装适合当前发行版的驱动"'
  const installable = canOfferNvidiaDriverInstall(snapshot.nvidiaSmi)
  const guidance = nvidiaIssueGuidance(snapshot.nvidiaSmi)
  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(command); setMessage('安装命令已复制') } catch { setMessage('无法访问剪贴板，请手动选择命令复制') }
  }
  const install = async () => {
    if (!window.confirm(`RackTop 将在 ${snapshot.osName} 上安装 NVIDIA 驱动包。继续吗？`)) return
    if (!window.confirm('该操作会通过 sudo 修改服务器软件包，且可能需要重启。确认执行？')) return
    setWorking(true)
    try { setMessage(await api.installNvidiaDriver(snapshot.serverId)) } catch (error) { setMessage(String(error)) } finally { setWorking(false) }
  }
  const supported = installable && (snapshot.osId === 'ubuntu' || snapshot.osId === 'debian')
  return <section className="nvidia-warning"><AlertCircle size={20} /><div><strong>{nvidiaIssueTitle(snapshot.nvidiaSmi)}</strong><p>{snapshot.nvidiaMessage || guidance}</p>{snapshot.nvidiaMessage && <small>{guidance}</small>}<small>检测到：{snapshot.osName}</small>{installable && <details open><summary>适用的安装命令</summary><code>{command}</code><small>驱动安装通常需要重启。自动安装只支持 Ubuntu / Debian，并且必须通过两次确认。</small></details>}{message && <p className="nvidia-warning__message" role="status">{message}</p>}<div className="nvidia-warning__actions">{supported && <button className="button button--primary button--small" disabled={working} onClick={() => void install()}>{working ? '安装中…' : '帮助安装'}</button>}{installable && <button className="button button--secondary button--small" onClick={() => void copyCommand()}>复制命令</button>}<button className="button button--secondary button--small" onClick={onRefresh}>重新检测</button><button className="button button--secondary button--small" onClick={onIgnore}><BellOff size={13} />忽略此提醒</button></div></div></section>
}

interface FleetTotals {
  online: number
  offline: number
  gpus: number
  idle: number
  gpuAverage: number
  cpuAverage: number
  hot: number
  gpuAnomalies: number
  latestRefresh: number | null
}

function MasonryItem({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const resize = () => {
      const grid = element.parentElement
      if (!grid) return
      const style = getComputedStyle(grid)
      const row = Number.parseFloat(style.gridAutoRows) || 4
      const gap = Number.parseFloat(style.rowGap) || 12
      element.style.gridRowEnd = `span ${Math.ceil((element.getBoundingClientRect().height + gap) / (row + gap))}`
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [])
  return <div className="masonry-item" ref={ref}>{children}</div>
}

function FleetOverview({ onboarding, servers, snapshots, settings, totals, sort, descending, onSort, onToggleOrder, onSelect }: { onboarding?: React.ReactNode; servers: Server[]; snapshots: Record<string, Snapshot>; settings: AppSettings | null; totals: FleetTotals; sort: 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount'; descending: boolean; onSort: (sort: 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount') => void; onToggleOrder: () => void; onSelect: (serverId: string, tab: DetailTab, gpuUuid?: string) => void }) {
  const metric = (server: Server) => {
    const snapshot = snapshots[server.id]
    const readableGpus = snapshot?.gpus.filter(isGpuAvailable) ?? []
    const average = readableGpus.length ? readableGpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / readableGpus.length : -1
    const idle = snapshot?.gpus.filter((gpu) => isGpuIdle(gpu, settings?.idleGpuThreshold ?? 10)).length ?? -1
    return { gpuCount: snapshot?.gpus.length ?? -1, utilization: average, idleCount: idle, status: ({ online: 4, warning: 3, connecting: 2, unknown: 1, offline: 0 })[server.status] }
  }
  const orderedServers = [...servers].sort((left, right) => {
    let comparison = 0
    if (sort === 'name') comparison = left.name.localeCompare(right.name, 'zh-CN')
    else comparison = metric(left)[sort] - metric(right)[sort]
    return descending ? -comparison : comparison
  })
  return <div className="detail-page fleet-page">
    {onboarding}
    <div className="fleet-toolbar">
      <section className="fleet-summary" aria-label="全局资源摘要">
        <span><ServerIcon size={16} /><strong>{totals.online}</strong><small>在线服务器</small></span>
        <span><WifiOff size={16} /><strong>{totals.offline}</strong><small>离线服务器</small></span>
        <span><Gauge size={16} /><strong>{totals.gpus}</strong><small>GPU 总数</small></span>
        <span><Activity size={16} /><strong>{totals.gpuAverage.toFixed(1)}%</strong><small>平均 GPU</small></span>
        <span><Cpu size={16} /><strong>{totals.cpuAverage.toFixed(1)}%</strong><small>平均 CPU</small></span>
        <span><Zap size={16} /><strong>{totals.idle}</strong><small>空闲 GPU</small></span>
        <span><AlertCircle size={16} /><strong>{totals.hot}</strong><small>温度异常</small></span>
        <span><ShieldAlert size={16} /><strong>{totals.gpuAnomalies}</strong><small>GPU 异常</small></span>
      </section>
      <div className="sort-controls"><ArrowDownUp size={14} /><label><span>排序</span><select value={sort} onChange={(event) => onSort(event.target.value as typeof sort)}><option value="name">服务器名称</option><option value="status">在线状态</option><option value="gpuCount">GPU 数量</option><option value="utilization">平均利用率</option><option value="idleCount">空闲 GPU 数</option></select></label><button className="button button--secondary button--small" onClick={onToggleOrder}>{descending ? '降序' : '升序'}</button></div>
    </div>
    <section className="fleet-grid" aria-label="服务器 GPU 状态墙">
      {orderedServers.map((server) => {
        const snapshot = snapshots[server.id]
        return <MasonryItem key={server.id}><article className={`panel fleet-card fleet-card--${server.status}`}>
          <button className="fleet-card__header" onClick={() => onSelect(server.id, 'overview')}>
            <span className={`server-row__status server-row__status--${server.status}`} />
            <span><strong>{server.name}</strong><small>{server.location ? `${server.location} · ` : ''}{snapshot ? `${snapshot.username}@${snapshot.hostname}` : `${server.username}@${server.host}`}</small></span>
            <StatusPill status={server.status} />
            <ChevronRight size={15} />
          </button>
          {snapshot ? <>
            <div className="fleet-system">
              <button onClick={() => onSelect(server.id, 'cpu')}><span>CPU</span><strong>{clampPercent(snapshot.system.cpuUtilization).toFixed(0)}%</strong><i><b style={{ width: `${clampPercent(snapshot.system.cpuUtilization)}%` }} /></i></button>
            </div>
            <div className="fleet-gpus">
              <div className="fleet-gpus__labels"><span>设备</span><span>显存</span><span>GPU</span></div>
              {snapshot.gpus.map((gpu) => {
                if (!isGpuAvailable(gpu)) return <button className="fleet-gpu-row fleet-gpu-row--unavailable" key={gpu.uuid} onClick={() => onSelect(server.id, 'gpu', gpu.uuid)}>
                  <span><strong>GPU {gpu.index}</strong><small>{gpu.name.replace('Unavailable GPU ', '')}</small></span>
                  <span>无法读取</span>
                  <span>—</span>
                </button>
                const memory = gpuMemoryPercent(gpu)
                const displayedMemory = displayedGpuMemoryPercent(memory)
                const ownProcess = snapshot.processes.some((process) => process.gpuUuid === gpu.uuid && process.isCurrentUser)
                const loadLevel = gpuLoadLevel(gpu.utilization)
                const memoryLevel = gpuMemoryLevel(memory)
                return <button className={`fleet-gpu-row fleet-gpu-row--${memoryLevel}`} style={{ '--memory-fill': `${displayedMemory}%` } as React.CSSProperties} key={gpu.uuid} onClick={() => onSelect(server.id, 'gpu', gpu.uuid)}>
                  <span><strong>GPU {gpu.index}</strong><small>{gpu.name.replace('NVIDIA ', '').replace('GeForce ', '')}</small></span>
                  <span>{displayedMemory}%<small>{(gpu.memoryUsedMb / 1024).toFixed(1)}G</small></span>
                  <span className={`fleet-gpu-row__load fleet-gpu-row__load--${loadLevel}`}>{clampPercent(gpu.utilization).toFixed(0)}%</span>
                  {ownProcess && <em title="有你的任务"><UserRound size={11} />你</em>}
                </button>
              })}
              {snapshot.gpus.length === 0 && <button className="fleet-no-gpu" onClick={() => onSelect(server.id, 'connection')}><AlertCircle size={14} />未检测到 NVIDIA GPU</button>}
            </div>
            <footer className="fleet-card__footer"><span>{snapshot.gpus.filter((gpu) => isGpuIdle(gpu, settings?.idleGpuThreshold ?? 10)).length} 张 GPU 空闲</span><time>{relativeTime(snapshot.timestamp)}</time></footer>
          </> : <div className="fleet-loading"><RefreshCw size={16} /><span>{server.lastError || '等待首次采样'}</span></div>}
        </article></MasonryItem>
      })}
    </section>
  </div>
}

function MineProcessView({ servers, snapshots, warnings, terminatingProcess, onDismissWarning, onOpenTerminal, onRequestTerminate }: { servers: Server[]; snapshots: Record<string, Snapshot>; warnings: MineProcessWarning[]; terminatingProcess: { serverId: string; pid: number } | null; onDismissWarning: (warningId: string) => void; onOpenTerminal: (serverId: string) => void; onRequestTerminate: (serverId: string, target: ProcessTerminationTarget) => void }) {
  const mineServers = servers.flatMap((server) => {
    const snapshot = snapshots[server.id]
    if (!snapshot) return []
    const mineSnapshot = { ...snapshot, processes: snapshot.processes.filter((process) => process.isCurrentUser), cpuProcesses: snapshot.cpuProcesses.filter((process) => process.isCurrentUser) }
    return mineSnapshot.processes.length || mineSnapshot.cpuProcesses.length ? [{ server, snapshot: mineSnapshot }] : []
  })
  const mineCount = mineServers.reduce((sum, item) => sum + currentUserProcessCount(item.snapshot), 0)
  const successNotices = warnings.filter((warning) => warning.tone === 'info')
  const persistentWarnings = warnings.filter((warning) => warning.tone === 'warning')
  return <div className="detail-page mine-process-page">{successNotices.length > 0 && <section className="mine-process-successes" aria-live="polite" aria-label="进程状态">{successNotices.map((notice) => <div className="mine-process-success" role="status" key={notice.id}><CheckCircle2 size={16} /><span>{notice.message}</span></div>)}</section>}{mineServers.length > 0 && <section className="mine-process-summary" aria-label="我的进程摘要"><span>{mineServers.length} 台服务器</span><strong>{mineCount} 个进程</strong></section>}{persistentWarnings.length > 0 && <section className="mine-process-warnings" aria-live="polite">{persistentWarnings.map((warning) => <div className="mine-process-warning mine-process-warning--warning" key={warning.id}><AlertCircle size={17} /><span>{warning.message}</span><button type="button" className="mine-process-warning__dismiss" onClick={() => onDismissWarning(warning.id)} aria-label="忽略这条提示" title="忽略"><X size={13} /></button></div>)}</section>}{mineServers.length > 0 ? <div className="mine-process-list">{mineServers.map(({ server, snapshot }) => <section className="mine-process-server" key={server.id}><PanelHeader icon={<ServerIcon />} title={server.name} subtitle={`${server.host} · 最近采集 ${relativeTime(snapshot.timestamp)}`} action={<button className="icon-button" aria-label={`打开 ${server.name} 终端`} title="打开终端" onClick={() => onOpenTerminal(server.id)}><TerminalSquare size={16} /></button>} /><ProcessBlocks snapshot={snapshot} hideEmptyBlocks terminatingPid={terminatingProcess?.serverId === server.id ? terminatingProcess.pid : undefined} onRequestTerminate={(target) => onRequestTerminate(server.id, target)} /></section>)}</div> : <div className="mine-process-empty" role="status"><UserRound size={28} /><strong>没有我的进程</strong><p>当前已连接的服务器上没有检测到你的 GPU 或 CPU 进程。</p></div>}</div>
}

function IdleGpuView({ servers, snapshots, items: rankedItems, filters, currentReservation, onFiltersChange, onReserve, sortRevision, onLaunch, onQuickTerminal, onSelect, onReserveGpu }: { servers: Server[]; snapshots: Record<string, Snapshot>; items: IdleGpuItem[]; filters: IdleFilters; currentReservation?: IdleReservation; onFiltersChange: (filters: IdleFilters) => void; onReserve: () => void; sortRevision: number; onLaunch: (server: Server, gpu: Snapshot['gpus'][number]) => void; onQuickTerminal: (server: Server, gpu: Snapshot['gpus'][number]) => void; onSelect: (serverId: string, gpuUuid: string) => void; onReserveGpu: (server: Server, gpu: Snapshot['gpus'][number]) => void }) {
  const [gpuMemoryInput, setGpuMemoryInput] = useState(String(filters.gpuMemoryGb))
  const [cpuMemoryInput, setCpuMemoryInput] = useState(String(filters.cpuMemoryGb))
  const { gpuMemoryGb, cpuMemoryGb, otherUserProcess, duration, gpuModel, cpuModel, tag } = filters
  const gpuModels = Array.from(new Set(Object.values(snapshots).flatMap((snapshot) => snapshot.gpus.map((gpu) => gpu.name)))).sort()
  const cpuModels = Array.from(new Set(Object.values(snapshots).map((snapshot) => snapshot.system.cpuModel || '未知 CPU'))).sort()
  const tags = Array.from(new Set(servers.flatMap((server) => server.tags))).sort()
  const filterSignature = `${gpuMemoryGb}|${cpuMemoryGb}|${otherUserProcess}|${duration}|${gpuModel}|${cpuModel}|${tag}|${sortRevision}`
  const orderRef = useRef<{ signature: string; keys: string[] }>({ signature: '', keys: [] })
  const currentKeys = rankedItems.map(({ server, gpu }) => `${server.id}:${gpu.uuid}`)
  if (orderRef.current.signature !== filterSignature) {
    orderRef.current = { signature: filterSignature, keys: currentKeys }
  } else {
    const currentKeySet = new Set(currentKeys)
    const retained = orderRef.current.keys.filter((key) => currentKeySet.has(key))
    const retainedSet = new Set(retained)
    orderRef.current.keys = [...retained, ...currentKeys.filter((key) => !retainedSet.has(key))]
  }
  const order = new Map(orderRef.current.keys.map((key, index) => [key, index]))
  const items = [...rankedItems].sort((left, right) => (order.get(`${left.server.id}:${left.gpu.uuid}`) ?? Number.MAX_SAFE_INTEGER) - (order.get(`${right.server.id}:${right.gpu.uuid}`) ?? Number.MAX_SAFE_INTEGER))
  const availableCount = items.filter((item) => item.available).length
  const setFilters = (next: Partial<IdleFilters>) => onFiltersChange({ ...filters, ...next })
  const setNumericFilter = (key: 'gpuMemoryGb' | 'cpuMemoryGb', input: string, setInput: (value: string) => void) => {
    setInput(input)
    setFilters({ [key]: input.trim() === '' ? 0 : Math.max(0, Number(input) || 0) })
  }
  const reset = () => { setGpuMemoryInput(String(DEFAULT_IDLE_FILTERS.gpuMemoryGb)); setCpuMemoryInput(String(DEFAULT_IDLE_FILTERS.cpuMemoryGb)); onFiltersChange({ ...DEFAULT_IDLE_FILTERS }) }
  const filterSummary = idleFilterSummaryParts(filters)

  return <div className="detail-page idle-page">
    <section className="idle-filters" aria-label="空闲算力筛选条件">
      <header><div><SlidersHorizontal size={17} /><div><strong>空闲条件</strong><small>仅检测其他用户；系统显示进程与不超过 GPU MEM 3% 的小占用不计入</small></div></div><div className="idle-filter-actions"><button className={`button button--secondary button--small ${currentReservation ? 'is-active' : ''}`} onClick={onReserve}><BellPlus size={13} />{currentReservation?.status === 'active' ? '预约中' : currentReservation?.status === 'paused' ? '已暂停' : '预约'}</button><button className="button button--secondary button--small" onClick={reset}><RotateCcw size={13} />重置</button></div></header>
      <div className="idle-filter-grid">
        <label>GPU MEM 至少<div><input inputMode="decimal" type="number" min="0" step="5" value={gpuMemoryInput} onChange={(event) => setNumericFilter('gpuMemoryGb', event.target.value, setGpuMemoryInput)} onBlur={() => setGpuMemoryInput(String(gpuMemoryGb))} /><span>GB</span></div></label>
        <label>CPU MEM 至少<div><input inputMode="decimal" type="number" min="0" step="10" value={cpuMemoryInput} onChange={(event) => setNumericFilter('cpuMemoryGb', event.target.value, setCpuMemoryInput)} onBlur={() => setCpuMemoryInput(String(cpuMemoryGb))} /><span>GB</span></div></label>
        <label>进程占用<select value={otherUserProcess} onChange={(event) => setFilters({ otherUserProcess: event.target.value as IdleFilters['otherUserProcess'] })}><option value="without">无人占用</option><option value="all">不限</option></select></label>
        <label>GPU 型号<select value={gpuModel} onChange={(event) => setFilters({ gpuModel: event.target.value })}><option value="all">全部型号</option>{gpuModels.map((item) => <option value={item} key={item}>{item.replace('NVIDIA ', '')}</option>)}</select></label>
        <label>CPU 型号<select value={cpuModel} onChange={(event) => setFilters({ cpuModel: event.target.value })}><option value="all">全部型号</option>{cpuModels.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label>持续时间<select value={duration} onChange={(event) => setFilters({ duration: Number(event.target.value) })}><option value="0">当前快照</option><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></label>
        <label>服务器标签<select value={tag} onChange={(event) => setFilters({ tag: event.target.value })}><option value="all">全部标签</option>{tags.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
      </div>
      <footer>{filterSummary.map((summary) => <span key={summary}>{summary}</span>)}<strong>{availableCount} 张可用 · {items.length - availableCount} 张不可用</strong></footer>
    </section>
    <section className="idle-grid">{items.map(({ server, gpu, available }) => {
      const snapshot = snapshots[server.id]
      const freeGpuGb = displayedFreeMemoryGb(gpu.memoryTotalMb - gpu.memoryUsedMb)
      const freeCpuGb = displayedFreeMemoryGb(((snapshot?.system.memoryTotalBytes ?? 0) - (snapshot?.system.memoryUsedBytes ?? 0)) / 1024 ** 2)
      const occupiedProcessCount = countOtherUserGpuWorkloads(gpu, snapshot?.processes ?? [])
      return <article className={`panel idle-card ${available ? '' : 'idle-card--unavailable'}`} key={`${server.id}-${gpu.uuid}`}>
        <button className="idle-card__target" onClick={() => available ? onLaunch(server, gpu) : onReserveGpu(server, gpu)} aria-label={`${available ? '使用算力启动任务' : '预约'} ${server.name} GPU ${gpu.index}`} title={available ? '使用此 GPU 启动任务' : '预约此卡'} />
        <div className="idle-card__body">
          <div className="idle-card__top"><span className={`idle-badge ${available ? '' : 'idle-badge--unavailable'}`}>{available ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{available ? '可用' : '不可用'}</span>{!available && <span className="idle-card__primary-action" aria-hidden="true"><BellPlus size={15} /></span>}</div>
          <h3>{server.name} · GPU {gpu.index}</h3><p>{gpu.name} · {snapshot?.system.cpuModel || '未知 CPU'}</p><div className="idle-card__stats"><span><strong>{freeGpuGb.toFixed(1)} GB</strong><small>GPU MEM</small></span><span><strong>{freeCpuGb.toFixed(1)} GB</strong><small>CPU MEM</small></span><span><strong>{occupiedProcessCount > 0 ? `有 ${occupiedProcessCount} 个` : '无'}</strong><small>进程占用</small></span></div><div className="tag-row">{server.tags.map((item) => <span key={item}>{item}</span>)}</div>
        </div>
        <div className="idle-card__actions">{available && <><button className="icon-button idle-card__launch" onClick={() => onLaunch(server, gpu)} aria-label={`使用 ${server.name} GPU ${gpu.index} 启动任务`} title="启动任务"><Play size={15} /></button><button className="icon-button idle-card__terminal" onClick={() => onQuickTerminal(server, gpu)} aria-label={`打开 ${server.name} GPU ${gpu.index} 终端`} title="打开终端"><TerminalSquare size={15} /></button></>}<button className="icon-button idle-card__detail" onClick={() => onSelect(server.id, gpu.uuid)} aria-label={`打开 ${server.name} GPU ${gpu.index} 详情`} title="查看详情"><ChevronRight size={15} /></button></div>
      </article>
    })}{items.length === 0 && <div className="inline-empty inline-empty--wide"><WifiOff size={28} /><strong>没有对应范围的 GPU</strong><p>当前没有符合所选 GPU 型号、CPU 型号或服务器标签的设备。</p></div>}</section>
  </div>
}

type ReservationExpiration = '2h' | 'today' | '24h' | 'forever'

function reservationExpiresAt(value: ReservationExpiration, nowSeconds: number): number | null {
  if (value === 'forever') return null
  if (value === '2h') return nowSeconds + 2 * 60 * 60
  if (value === '24h') return nowSeconds + 24 * 60 * 60
  const endOfToday = new Date()
  endOfToday.setHours(23, 59, 59, 999)
  return Math.floor(endOfToday.getTime() / 1000)
}

function reservationExpirationPreset(reservation?: IdleReservation): ReservationExpiration {
  if (!reservation || reservation.expiresAt === null) return reservation ? 'forever' : '24h'
  const remainingSeconds = reservation.expiresAt - Math.floor(Date.now() / 1000)
  return remainingSeconds <= 3 * 60 * 60 ? '2h' : '24h'
}

function defaultReservationName(filters: IdleReservationFilters): string {
  if (filters.gpuModel !== 'all') return `${filters.gpuModel.replace('NVIDIA ', '')} 预约`
  return filters.gpuMemoryGb > 0 ? `${filters.gpuMemoryGb} GB 显存预约` : '空闲算力预约'
}

function formatReservationExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return '一直有效'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(expiresAt * 1000))
}

function IdleReservationSheet({ reservation, filters, availableGpuKeys, onClose, onSave }: { reservation?: IdleReservation; filters: IdleReservationFilters; availableGpuKeys: string[]; onClose: () => void; onSave: (reservation: IdleReservation) => Promise<void> }) {
  const [name, setName] = useState(reservation?.name ?? defaultReservationName(filters))
  const [expiration, setExpiration] = useState<ReservationExpiration>(() => reservationExpirationPreset(reservation))
  const [expirationChanged, setExpirationChanged] = useState(false)
  const [notifyMode, setNotifyMode] = useState<IdleReservation['notifyMode']>(reservation?.notifyMode ?? 'once')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isEditing = Boolean(reservation)
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet reservation-sheet" role="dialog" aria-modal="true" aria-labelledby="reservation-title">
      <header className="sheet__header"><div><p className="eyebrow">空闲算力预约</p><h2 id="reservation-title">{isEditing ? '编辑预约' : '预约当前条件'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="reservation-body">
        <div className="reservation-condition"><span><BellPlus size={16} /></span><div><strong>{idleReservationSummary(filters)}</strong><small>预约只负责监测和通知，不会锁定或占用 GPU。</small></div></div>
        {!isEditing && <p className="reservation-baseline" role="status">当前已有 <strong>{availableGpuKeys.length}</strong> 张 GPU 满足条件。它们会作为已知状态保存，不会在创建后立即重复通知。</p>}
        <div className="reservation-fields">
          <label>预约名称<input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} /></label>
          <label>有效期<select value={expiration} onChange={(event) => { setExpiration(event.target.value as ReservationExpiration); setExpirationChanged(true) }}><option value="2h">2 小时</option><option value="today">今天</option><option value="24h">24 小时</option><option value="forever">一直有效</option></select></label>
          <label>命中后<select value={notifyMode} onChange={(event) => setNotifyMode(event.target.value as IdleReservation['notifyMode'])}><option value="once">通知一次并结束</option><option value="continuous">通知后继续监测</option></select></label>
        </div>
        <p className="reservation-note">“当前快照”需要连续满足 {CURRENT_SNAPSHOT_STABLE_SECONDS} 秒；选择了持续时间时，按所选时长判断。应用完全退出后无法继续监测。</p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="sheet__footer"><button className="button button--secondary" onClick={onClose} disabled={saving}>取消</button><button className="button button--primary" disabled={saving || !name.trim()} onClick={async () => {
        setSaving(true)
        setError(null)
        const nowSeconds = Math.floor(Date.now() / 1000)
        const nextStatus = reservation?.status === 'paused' ? 'paused' : 'active'
        try {
          await onSave({
            id: reservation?.id ?? crypto.randomUUID(),
            name: name.trim(),
            filters: { ...filters },
            createdAt: reservation?.createdAt ?? nowSeconds,
            expiresAt: reservation && !expirationChanged ? reservation.expiresAt : reservationExpiresAt(expiration, nowSeconds),
            notifyMode,
            status: reservation?.status === 'completed' || reservation?.status === 'expired' ? 'active' : nextStatus,
            matchedGpuKeys: reservation?.matchedGpuKeys ?? [...availableGpuKeys].sort(),
            currentAvailableGpuKeys: reservation?.currentAvailableGpuKeys ?? [...availableGpuKeys].sort(),
            pendingConfirmationGpuKeys: reservation?.pendingConfirmationGpuKeys ?? [],
          })
        } catch (reason) {
          setError(String(reason))
          setSaving(false)
        }
      }}>{saving ? '保存中…' : isEditing ? '保存预约' : '开始预约'}</button></footer>
    </section>
  </div>
}

const reservationStatusLabel: Record<IdleReservation['status'], string> = { active: '监测中', paused: '已暂停', completed: '已完成', expired: '已过期' }

function IdleReservationCenter({ reservations, warnings, onClose, onEdit, onStatusChange, onClearPending, onDelete, onIgnoreWarning }: { reservations: IdleReservation[]; warnings: GpuMemoryStallWarning[]; onClose: () => void; onEdit: (reservation: IdleReservation) => void; onStatusChange: (reservation: IdleReservation, status: IdleReservation['status']) => Promise<void>; onClearPending: (reservation: IdleReservation) => Promise<void>; onDelete: (reservationId: string) => Promise<void>; onIgnoreWarning: (warning: GpuMemoryStallWarning) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const activeCount = reservations.filter((reservation) => reservation.status === 'active').length
  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id)
    setError(null)
    try { await action() } catch (reason) { setError(String(reason)) } finally { setBusyId(null) }
  }
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet reservation-center-sheet" role="dialog" aria-modal="true" aria-labelledby="reservation-center-title">
      <header className="sheet__header"><div><p className="eyebrow">预约与通知</p><h2 id="reservation-center-title">{activeCount} 个预约正在监测{warnings.length ? ` · ${warnings.length} 个预警` : ''}</h2></div></header>
      <div className="reservation-list">
        {warnings.map((warning) => <div className="reservation-row reservation-row--warning" key={warning.id}>
          <span className="reservation-row__status reservation-row__status--warning"><AlertCircle size={15} /></span>
          <div className="reservation-row__content"><div><strong>{gpuContextName(warning.serverName, warning.gpuIndex, warning.gpuName)}</strong><em>显存占用预警</em></div><p>{warning.defunctProcesses.length ? `检测到僵尸 GPU 进程，仍占用 ${(warning.memoryUsedMb / 1024).toFixed(1)} / ${(warning.memoryTotalMb / 1024).toFixed(1)} GB 显存` : `GPU MEM 已占用 ${(warning.memoryUsedMb / 1024).toFixed(1)} / ${(warning.memoryTotalMb / 1024).toFixed(1)} GB，但 UTL 为 0，已持续 ${Math.floor(warning.durationSeconds / 3600)} 小时`}</p><small>{warning.defunctProcesses.length ? `进程：${warning.defunctProcesses.map((process) => `${process.username}（PID ${process.pid}）`).join('、')}` : warning.usernames.length ? `用户：${warning.usernames.join('、')}` : '未识别到对应进程'}</small></div>
          <div className="reservation-row__actions"><button className="button button--secondary button--small" onClick={() => onIgnoreWarning(warning)}>忽略</button></div>
        </div>)}
        {reservations.map((reservation) => <div className="reservation-row" key={reservation.id}>
          <span className={`reservation-row__status reservation-row__status--${reservation.status}`}><Bell size={15} /></span>
          <div className="reservation-row__content"><div><strong>{reservation.name}</strong><em>{reservationStatusLabel[reservation.status]}</em></div><p>{idleReservationSummary(reservation.filters)}</p><small>{formatReservationExpiry(reservation.expiresAt)} · {reservation.notifyMode === 'once' ? '通知一次' : '持续监测'}{reservation.currentAvailableGpuKeys?.length ? ` · 当前可用 ${reservation.currentAvailableGpuKeys.length}` : ''}{reservation.pendingConfirmationGpuKeys?.length ? ` · 待确认 ${reservation.pendingConfirmationGpuKeys.length}` : ''}</small></div>
          <div className="reservation-row__actions">
            <button className="icon-button" title="编辑预约" aria-label={`编辑 ${reservation.name}`} disabled={busyId === reservation.id} onClick={() => onEdit(reservation)}><Pencil size={14} /></button>
            {reservation.status === 'active' && <button className="icon-button" title="暂停预约" aria-label={`暂停 ${reservation.name}`} disabled={busyId === reservation.id} onClick={() => void run(reservation.id, () => onStatusChange(reservation, 'paused'))}><Pause size={14} /></button>}
            {(reservation.status === 'paused' || reservation.status === 'completed') && <button className="icon-button" title="恢复预约" aria-label={`恢复 ${reservation.name}`} disabled={busyId === reservation.id} onClick={() => void run(reservation.id, () => onStatusChange(reservation, 'active'))}><Play size={14} /></button>}
            {!!reservation.pendingConfirmationGpuKeys?.length && <button className="button button--secondary button--small" title="清除待确认" disabled={busyId === reservation.id} onClick={() => void run(reservation.id, () => onClearPending(reservation))}>已确认</button>}
            <button className="icon-button reservation-delete" title="删除预约" aria-label={`删除 ${reservation.name}`} disabled={busyId === reservation.id} onClick={() => void run(reservation.id, () => onDelete(reservation.id))}><Trash2 size={14} /></button>
          </div>
        </div>)}
        {reservations.length === 0 && warnings.length === 0 && <div className="inline-empty"><Bell size={24} /><strong>还没有预约</strong><p>在“寻找空闲算力”的条件栏中创建预约。</p></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>完成</button></footer>
    </section>
  </div>
}

export function SettingsSheet({ settings, onboardingVisible, onClose, onSave }: { settings: AppSettings; onboardingVisible: boolean; onClose: () => void; onSave: (settings: AppSettings, showOnboarding: boolean) => Promise<void> }) {
  const [value, setValue] = useState(settings)
  const [showOnboarding, setShowOnboarding] = useState(onboardingVisible)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof AppSettings>(key: K, next: AppSettings[K]) => setValue((current) => ({ ...current, [key]: next }))
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="sheet__header"><div><p className="eyebrow">偏好设置</p><h2 id="settings-title">外观、采样与历史</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="settings-body">
        <SettingsGroup icon={<CheckCircle2 />} title="通用">
          <label className="switch-row"><span><strong>显示新手引导</strong><small>在算力总览顶部显示五步清单，引导完成服务器接入、添加数据集或模型、项目关联、启动配置和首次任务。</small></span><input type="checkbox" checked={showOnboarding} onChange={(event) => setShowOnboarding(event.target.checked)} /></label>
          <label className="switch-row"><span><strong>显示添加服务器引导</strong><small>新增服务器时先显示 SSH 安全连接说明，包括认证方式、Host Key 核验和远端历史设置。</small></span><input type="checkbox" checked={value.showAddServerGuide} onChange={(event) => set('showAddServerGuide', event.target.checked)} /></label>
        </SettingsGroup>
        <SettingsGroup icon={<SlidersHorizontal />} title="外观">
          <label>主题<select value={value.theme} onChange={(event) => set('theme', event.target.value as AppSettings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <div className="settings-choice-row"><span><strong>菜单栏状态</strong><small>扩展模式固定显示待处理预约和异常进程数量</small></span><div className="segmented settings-mode" role="group" aria-label="菜单栏状态模式"><button type="button" className={value.menuBarMode === 'compact' ? 'is-selected' : ''} aria-pressed={value.menuBarMode === 'compact'} onClick={() => set('menuBarMode', 'compact')}>紧凑</button><button type="button" className={value.menuBarMode === 'expanded' ? 'is-selected' : ''} aria-pressed={value.menuBarMode === 'expanded'} onClick={() => set('menuBarMode', 'expanded')}>扩展</button></div></div>
          <label className="switch-row"><span><strong>我的任务标记色</strong><small>用于显存光标、你的任务标签与侧栏提示</small></span><input type="color" value={value.currentUserAccent} onChange={(event) => set('currentUserAccent', event.target.value)} /></label>
          <label className="switch-row"><span><strong>减少非必要动效</strong><small>也会自动尊重系统“减少动态效果”设置</small></span><input type="checkbox" checked={value.reduceMotion} onChange={(event) => set('reduceMotion', event.target.checked)} /></label>
        </SettingsGroup>
        <SettingsGroup icon={<RefreshCw />} title="采样">
          <label>后台最低采样间隔 <span>{value.backgroundSamplingIntervalSeconds} 秒</span><input type="range" min="5" max="120" value={value.backgroundSamplingIntervalSeconds} onChange={(event) => set('backgroundSamplingIntervalSeconds', Number(event.target.value))} /></label>
          <label>进程刷新 <select value={value.processIntervalSeconds} onChange={(event) => set('processIntervalSeconds', Number(event.target.value))}><option value="2">2 秒</option><option value="5">5 秒</option><option value="10">10 秒</option><option value="30">30 秒</option></select></label>
          <label>实时趋势窗口 <span>{value.realtimeWindowMinutes} 分钟</span><input type="range" min="10" max="360" step="10" value={value.realtimeWindowMinutes} onChange={(event) => set('realtimeWindowMinutes', Number(event.target.value))} /></label>
        </SettingsGroup>
        <SettingsGroup icon={<Database />} title="历史">
          <label className="switch-row"><span><strong>保存历史数据</strong><small>使用本地 SQLite，固定保留最近 90 天</small></span><input type="checkbox" checked={value.historyEnabled} onChange={(event) => set('historyEnabled', event.target.checked)} /></label>
        </SettingsGroup>
        <SettingsGroup icon={<CircleGauge />} title="空闲与告警">
          <label>空闲 GPU 阈值 <span>{value.idleGpuThreshold}%</span><input type="range" min="0" max="30" value={value.idleGpuThreshold} onChange={(event) => set('idleGpuThreshold', Number(event.target.value))} /></label>
          <label>空闲通知持续时间 <select value={value.idleDurationMinutes} onChange={(event) => set('idleDurationMinutes', Number(event.target.value))}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></label>
          <label>显存释放阈值 <span>{(value.idleMemoryThresholdMb / 1024).toFixed(0)} GB</span><input type="range" min="0" max="163840" step="4096" value={value.idleMemoryThresholdMb} onChange={(event) => set('idleMemoryThresholdMb', Number(event.target.value))} /></label>
          <label>温度告警 <span>{value.temperatureThresholdCelsius}°C</span><input type="range" min="60" max="95" value={value.temperatureThresholdCelsius} onChange={(event) => set('temperatureThresholdCelsius', Number(event.target.value))} /></label>
        </SettingsGroup>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={saving} onClick={async () => { setSaving(true); setError(null); try { await onSave(value, showOnboarding) } catch (reason) { setError(String(reason)) } finally { setSaving(false) } }}>{saving ? '保存中…' : '保存设置'}</button></footer>
    </section>
  </div>
}

function ActivityLogSheet({ servers, snapshots, onClose }: { servers: Server[]; snapshots: Record<string, Snapshot>; onClose: () => void }) {
  const [summary, setSummary] = useState<InteractionLogSummary>({ sentBytes: 0, responseBytes: 0, storedBytes: 0, localStorageBytes: 0, failureCount: 0, servers: [] })
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const next = await api.getInteractionLogSummary()
        if (active) { setSummary(next); setNow(Date.now()); setError(null) }
      } catch (reason) {
        if (active) setError(String(reason))
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const serverById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers])
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet activity-log-sheet" role="dialog" aria-modal="true" aria-labelledby="activity-log-title">
      <header className="sheet__header"><div><p className="eyebrow">当前运行周期 · 退出 App 后清空</p><h2 id="activity-log-title">日志</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="activity-log-body">
        <dl className="activity-log-totals" aria-label="当前运行周期数据总量">
          <div><dt>发送数据</dt><dd>{formatDataBytes(summary.sentBytes)}</dd></div>
          <div><dt>接收数据</dt><dd>{formatDataBytes(summary.responseBytes)}</dd></div>
          <div><dt>本次逻辑写入</dt><dd>{formatDataBytes(summary.storedBytes)}</dd></div>
          <div><dt>本地历史占用</dt><dd>{formatDataBytes(summary.localStorageBytes)}</dd></div>
          <div><dt>失败</dt><dd>{summary.failureCount}</dd></div>
        </dl>
        {error && <p className="form-error activity-log-error" role="alert">无法读取实时日志：{error}</p>}
        <div className="activity-log-servers">
          {summary.servers.map((entry) => {
            const visualStatus = interactionVisualStatus(entry.status, entry.lastStartedAt, now)
            const dataItems = acquiredDataItems(serverById.get(entry.serverId), snapshots[entry.serverId])
            const latestTime = entry.lastFinishedAt ?? entry.lastStartedAt
            const latestLabel = Math.max(0, now - latestTime) < 5_000 ? '刚刚' : new Date(latestTime).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
            return <article className={`activity-log-server activity-log-server--${visualStatus}`} key={entry.serverId}>
              <header className="activity-log-server__header"><strong>{entry.serverName}</strong><span>{visualStatus === 'running' ? '处理中' : visualStatus === 'error' ? '失败' : '正常'}</span></header>
              <p className="activity-log-server__traffic"><span>最后交互：{latestLabel}</span><span>发送 {formatDataBytes(entry.sentBytes)}</span><span>接收 {formatDataBytes(entry.responseBytes)}</span><span>本次写入 {formatDataBytes(entry.storedBytes)}</span></p>
              <div className="activity-log-data"><h3>获得的数据</h3><dl>{dataItems.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></div>
              <details className="activity-log-command"><summary><span>最近命令</span><time>{latestLabel} · 耗时 {interactionDurationSeconds(entry.lastStartedAt, entry.lastFinishedAt, now).toFixed(2)} 秒</time><em>展开</em></summary><pre><code>{entry.lastCommand}</code></pre></details>
              {entry.error && <p className="activity-log-server__error">{entry.error}</p>}
            </article>
          })}
          {!error && summary.servers.length === 0 && <div className="activity-log-empty-state"><ScrollText size={24} /><strong>等待首次服务器交互</strong><p>发送、接收和本地写入数据会在这里按服务器汇总。</p></div>}
        </div>
      </div>
      <footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>关闭</button></footer>
    </section>
  </div>
}

function SettingsGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <section className="settings-group"><header><span>{icon}</span><h3>{title}</h3></header><div>{children}</div></section>
}

function AboutSheet({ onClose, onNotice }: { onClose: () => void; onNotice: (message: string) => void }) {
  const [licenses, setLicenses] = useState(false)
  const openExternal = (url: string) => {
    void openExternalUrl(url).catch((error) => onNotice(`无法打开默认浏览器：${String(error)}`))
  }
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet about-sheet" role="dialog" aria-modal="true" aria-labelledby="about-title"><header className="sheet__header"><div><p className="eyebrow">About</p><h2 id="about-title">RackTop</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="about-body"><div className="about-product"><span className="about-product__mark"><Activity size={28} /></span><div><strong>RackTop {packageInfo.version}</strong><p>面向共享 GPU 服务器的安静、实时算力监控与 SSH 工作台。</p></div></div><div className="about-author"><img src={authorAvatar} alt="Tongzh-SEU 头像" /><div><strong>Tongzh-SEU</strong><small>作者与维护者</small><button className="about-external-link" onClick={() => openExternal('https://github.com/Tongzh-SEU')}><Github size={13} />GitHub @Tongzh-SEU<ExternalLink size={11} /></button></div></div><div className="about-links"><button onClick={() => openExternal('https://github.com/Tongzh-SEU/RackTop')}><Github size={15} /><span><strong>GitHub 仓库</strong><small>Tongzh-SEU/RackTop</small></span><ExternalLink size={13} /></button><button aria-expanded={licenses} aria-controls="about-licenses" onClick={() => setLicenses((value) => !value)}><Database size={15} /><span><strong>第三方许可</strong><small>{licenses ? '收起开源组件' : '查看主要运行时依赖'}</small></span><ChevronRight className={`disclosure-icon${licenses ? ' disclosure-icon--expanded' : ''}`} size={13} /></button></div>{licenses && <div className="about-licenses" id="about-licenses"><p><strong>React、Tauri、xterm.js、ECharts、Lucide</strong></p><p>各组件版权归其贡献者所有，并按各自开源许可证分发。完整版本与传递依赖记录见应用包内的 npm 与 Cargo 锁文件。</p></div>}<small className="about-contact">联系：通过 GitHub Issues 或作者主页发起讨论</small></div><footer className="sheet__footer"><button className="button button--primary" onClick={onClose}>完成</button></footer></section></div>
}

function SshImportSheet({ drafts, servers, onClose, onImport }: { drafts: ServerDraft[]; servers: Server[]; onClose: () => void; onImport: (drafts: ServerDraft[]) => Promise<void> }) {
  const duplicates = useMemo(() => duplicateImportIndexes(drafts, servers), [drafts, servers])
  const availableCount = drafts.length - duplicates.size
  const [selected, setSelected] = useState(() => new Set(drafts.map((_, index) => index).filter((index) => !duplicates.has(index))))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (index: number) => { if (!duplicates.has(index)) setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next }) }
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet import-sheet" role="dialog" aria-modal="true" aria-labelledby="ssh-import-title"><header className="sheet__header"><div><p className="eyebrow">OpenSSH Config</p><h2 id="ssh-import-title">选择要监控的服务器</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="import-list">{duplicates.size > 0 && <p className="import-notice" role="status"><AlertCircle size={15} /><span>已识别并跳过 {duplicates.size} 台重复服务器；相同用户名、地址与端口只保留一条连接。</span></p>}{drafts.map((draft, index) => { const duplicate = duplicates.has(index); return <label className={`import-row ${duplicate ? 'import-row--duplicate' : ''}`} key={`${draft.sshAlias}-${draft.host}-${index}`}><input type="checkbox" checked={selected.has(index)} disabled={duplicate} onChange={() => toggle(index)} /><span><strong>{draft.sshAlias || draft.name}</strong><small>{draft.username}@{draft.host}:{draft.port}{draft.proxyJump ? ` · via ${draft.proxyJump}` : ''}</small></span>{duplicate && <em>已存在</em>}</label>})}{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="sheet__footer"><span className="sheet__selection-count">已选 {selected.size} / {availableCount} 台可导入</span><button className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={saving || selected.size === 0} onClick={async () => { setSaving(true); setError(null); try { await onImport(drafts.filter((_, index) => selected.has(index))) } catch (reason) { setError(String(reason)) } finally { setSaving(false) } }}>{saving ? '导入中…' : `导入 ${selected.size} 台`}</button></footer></section></div>
}

function TerminateProcessDialog({ target, onClose, onTerminate }: { target: ProcessTerminationTarget & { serverId: string; serverName: string }; onClose: () => void; onTerminate: () => void }) {
  const [stage, setStage] = useState<'review' | 'verify'>('review')
  const [confirmation, setConfirmation] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pid = target.process.pid
  const expected = String(pid)
  const copyPid = async () => {
    try {
      await navigator.clipboard.writeText(expected)
      setCopied(true)
    } catch {
      setCopied(false)
      setError('无法访问剪贴板，请手动输入 PID')
    }
  }
  return <div className="scrim"><section className="sheet terminate-process-sheet" role="alertdialog" aria-modal="true" aria-labelledby="terminate-process-title"><header className="sheet__header"><div><p className="eyebrow">结束远程进程</p><h2 id="terminate-process-title">{stage === 'review' ? `确认结束 PID ${pid}？` : '再次确认进程 PID'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="terminate-process-body"><span className="terminate-process-icon"><OctagonX size={24} /></span><div className="terminate-process-copy">{stage === 'review' ? <><p>将在 <strong>{target.serverName}</strong> 上结束当前 SSH 用户的 PID {pid}，并递归清理它下面的 CPU 子进程。同一终端中不相关的兄弟进程不会被结束。</p><dl><div><dt>进程</dt><dd>{target.kind.toUpperCase()} · PID {pid}</dd></div><div><dt>命令</dt><dd className="mono">{target.process.command}</dd></div></dl><small>先发送 TERM，3 秒后仍存在则发送 KILL。未保存的计算状态可能丢失。</small></> : <><p>点击下方 PID 可自动复制，然后将数字输入确认框。</p><button type="button" className={`copy-pid-button ${copied ? 'is-copied' : ''}`} onClick={() => void copyPid()} aria-label={`复制 PID ${pid}`}>{copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}<code>{copied ? `已复制 PID ${pid}` : `PID ${pid}`}</code></button><label>输入 PID 以确认<input autoFocus inputMode="numeric" value={confirmation} onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, ''))} placeholder={expected} /></label></>}{error && <p className="form-error" role="alert">{error}</p>}</div></div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button>{stage === 'review' ? <button className="button button--danger" onClick={() => setStage('verify')}>继续确认</button> : <button className="button button--danger" disabled={confirmation !== expected} onClick={onTerminate}>结束进程</button>}</footer></section></div>
}

function HostKeyDialog({ info, onClose, onTrust }: { info: HostKeyInfo; onClose: () => void; onTrust: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  return <div className="scrim"><section className={`sheet host-key-sheet ${info.changed ? 'host-key-sheet--changed' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="host-key-title"><header className="sheet__header"><div><p className="eyebrow">{info.changed ? 'SSH 安全警告' : '首次 SSH 连接'}</p><h2 id="host-key-title">{info.changed ? '服务器 Host Key 已变化' : '核对服务器指纹'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="host-key-body"><span className="host-key-icon"><ShieldAlert size={26} /></span><p>{info.changed ? <>RackTop 检测到 <strong>{info.host}</strong> 的密钥与本机记录不一致。这可能是服务器重装，也可能是中间人攻击。</> : <>这是 RackTop 第一次连接 <strong>{info.host}</strong>。请通过可信渠道与服务器管理员核对以下指纹。</>}</p><div className="fingerprint"><small>{info.algorithm}</small><code>{info.fingerprint}</code></div><p className="host-key-note">{info.changed ? '连接已被阻止。请先通过独立可信渠道核实新指纹，再使用系统 ssh-keygen 手动移除旧记录；RackTop 不会覆盖现有密钥。' : '只有在确认指纹一致后才继续。RackTop 不会自动接受未知 Host Key。'}</p></div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>{info.changed ? '保持阻止' : '取消连接'}</button>{!info.changed && <button className="button button--primary" disabled={saving} onClick={async () => { setSaving(true); try { await onTrust() } finally { setSaving(false) } }}>{saving ? '保存中…' : '指纹一致，信任并连接'}</button>}</footer></section></div>
}

export default App
