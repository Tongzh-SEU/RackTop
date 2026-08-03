import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  Bell,
  Box,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  Clock3,
  Cpu,
  Database,
  Download,
  Gauge,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  MemoryStick,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server as ServerIcon,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  UserRound,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { api } from './services/api'
import type { AppSettings, DetailTab, HistoryPoint, HostKeyInfo, Server, ServerDraft, Snapshot } from './types/models'
import { MetricBar } from './components/MetricBar'
import { ServerForm } from './components/ServerForm'
import { StatusPill } from './components/StatusPill'
import { TrendChart } from './components/TrendChart'
import { clampPercent, displayedGpuMemoryPercent, gpuLoadAccent, gpuLoadLevel, gpuMemoryLevel, gpuMemoryPercent, hasEnoughFreeGpuMemory, hasOtherUserGpuWorkload, isGpuIdle } from './utils/gpu'

const tabs: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'gpu', label: 'GPU' },
  { value: 'cpu', label: 'CPU' },
  { value: 'processes', label: '进程' },
  { value: 'history', label: '历史' },
  { value: 'logs', label: '日志' },
  { value: 'connection', label: '连接' },
]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
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

function serverToDraft(server: Server): Partial<ServerDraft> {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    sshAlias: server.sshAlias ?? undefined,
    identityFile: server.identityFile ?? undefined,
    proxyJump: server.proxyJump ?? undefined,
    tags: server.tags,
    samplingIntervalSeconds: server.samplingIntervalSeconds,
    historyRetentionDays: server.historyRetentionDays,
    authMethod: server.authMethod,
  }
}

function evaluateAlerts(server: Server | undefined, snapshot: Snapshot, previous: Snapshot | undefined, settings: AppSettings, since: Record<string, number>, notified: Set<string>) {
  const serverName = server?.name ?? snapshot.hostname
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
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [selectedTab, setSelectedTab] = useState<DetailTab>('overview')
  const [selectedGpuUuid, setSelectedGpuUuid] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showServerForm, setShowServerForm] = useState(false)
  const [editingServer, setEditingServer] = useState<Server | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [importDrafts, setImportDrafts] = useState<ServerDraft[] | null>(null)
  const [mainView, setMainView] = useState<'server' | 'fleet' | 'idle'>('fleet')
  const [fleetSort, setFleetSort] = useState<'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount'>(() => (localStorage.getItem('racktop.fleetSort') as 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount') || 'name')
  const [fleetDescending, setFleetDescending] = useState(() => localStorage.getItem('racktop.fleetDescending') === 'true')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [manualRefreshingAll, setManualRefreshingAll] = useState(false)
  const [manualRefreshingServers, setManualRefreshingServers] = useState<Set<string>>(new Set())
  const [paused, setPaused] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [pendingHostKey, setPendingHostKey] = useState<HostKeyInfo | null>(null)
  const initialLoad = useRef(false)
  const snapshotsRef = useRef<Record<string, Snapshot>>({})
  const failureCounts = useRef<Record<string, number>>({})
  const lastAttemptAt = useRef<Record<string, number>>({})
  const lastProcessAttemptAt = useRef<Record<string, number>>({})
  const nextRetryAt = useRef<Record<string, number>>({})
  const inFlightServers = useRef(new Set<string>())
  const deletedServerIds = useRef(new Set<string>())
  const conditionSince = useRef<Record<string, number>>({})
  const notifiedConditions = useRef(new Set<string>())

  const selectedServer = servers.find((server) => server.id === selectedServerId)
  const selectedSnapshot = selectedServerId ? snapshots[selectedServerId] : undefined

  const refreshServer = useCallback(async (serverId: string, quiet = false) => {
    if (inFlightServers.current.has(serverId)) return
    const nowMs = Date.now()
    const serverConfig = servers.find((server) => server.id === serverId)
    if (quiet && serverConfig) {
      const configuredInterval = document.hidden ? Math.max(serverConfig.samplingIntervalSeconds, settings?.backgroundSamplingIntervalSeconds ?? 15) : serverConfig.samplingIntervalSeconds
      if (nowMs - (lastAttemptAt.current[serverId] ?? 0) < configuredInterval * 1000 || nowMs < (nextRetryAt.current[serverId] ?? 0)) return
    }
    lastAttemptAt.current[serverId] = nowMs
    if (!quiet) delete nextRetryAt.current[serverId]
    inFlightServers.current.add(serverId)
    setBusy((current) => new Set(current).add(serverId))
    if (!snapshotsRef.current[serverId]) setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: 'connecting', lastError: null } : server))
    try {
      const previous = snapshotsRef.current[serverId]
      const includeProcesses = !quiet || !previous || nowMs - (lastProcessAttemptAt.current[serverId] ?? 0) >= (settings?.processIntervalSeconds ?? 5) * 1000
      const collected = await api.collectServer(serverId, includeProcesses)
      if (deletedServerIds.current.has(serverId)) return
      if (collected.processesSampled) lastProcessAttemptAt.current[serverId] = nowMs
      const snapshot = collected.processesSampled ? collected : { ...collected, processes: previous?.processes ?? [] }
      snapshotsRef.current = { ...snapshotsRef.current, [serverId]: snapshot }
      failureCounts.current[serverId] = 0
      delete nextRetryAt.current[serverId]
      notifiedConditions.current.delete(`offline:${serverId}`)
      if (settings) evaluateAlerts(servers.find((server) => server.id === serverId), snapshot, previous, settings, conditionSince.current, notifiedConditions.current)
      setSnapshots((current) => ({ ...current, [serverId]: snapshot }))
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: snapshot.status, lastSeenAt: snapshot.timestamp, lastError: snapshot.nvidiaMessage } : server))
      const from = snapshot.timestamp - (settings?.realtimeWindowMinutes ?? 30) * 60
      try {
        const points = await api.getHistory(serverId, from)
        if (!deletedServerIds.current.has(serverId)) setHistory((current) => ({ ...current, [serverId]: points }))
      } catch (historyError) {
        if (!quiet) setToast(`历史数据读取失败：${String(historyError)}`)
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
          const name = servers.find((server) => server.id === serverId)?.name ?? serverId
          void api.notify(`${name} 已离线`, `连续 ${failureCounts.current[serverId]} 次采集失败：${message}`)
        }
      }
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: failureCount >= 3 ? 'offline' : 'warning', lastError: `${message} · ${retryDelays[Math.min(failureCount - 1, retryDelays.length - 1)]} 秒后重试` } : server))
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
  }, [settings, servers])

  const refreshAll = useCallback(async (quiet = false) => {
    await Promise.allSettled(servers.map((server) => refreshServer(server.id, quiet)))
  }, [servers, refreshServer])

  const runManualRefreshAll = useCallback(async () => {
    if (manualRefreshingAll) return
    setManualRefreshingAll(true)
    try { await refreshAll(false) } finally { setManualRefreshingAll(false) }
  }, [manualRefreshingAll, refreshAll])

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
    void Promise.all([api.listServers(), api.getSettings()]).then(([loadedServers, loadedSettings]) => {
      setServers(loadedServers)
      setSettings(loadedSettings)
      setSelectedServerId((current) => current ?? loadedServers[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (servers.length === 0 || initialLoad.current) return
    initialLoad.current = true
    void refreshAll(true)
  }, [servers.length, refreshAll])

  useEffect(() => {
    if (!settings || servers.length === 0 || paused) return
    const interval = window.setInterval(() => void refreshAll(true), 1000)
    return () => window.clearInterval(interval)
  }, [settings, servers.length, refreshAll, paused])

  useEffect(() => {
    if (!api.isDesktop) return
    const unlisten = listen<string>('tray-action', ({ payload }) => {
      if (payload === 'idle') setMainView('idle')
      if (payload === 'connect') void refreshAll()
      if (payload === 'pause') setPaused((value) => !value)
    })
    return () => { void unlisten.then((dispose) => dispose()) }
  }, [refreshAll])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [toast])

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

  const visibleServers = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return servers
    return servers.filter((server) => [server.name, server.host, server.username, ...server.tags].some((value) => value.toLowerCase().includes(needle)))
  }, [servers, search])

  const totals = useMemo(() => {
    const values = Object.values(snapshots)
    const gpus = values.flatMap((snapshot) => snapshot.gpus)
    const online = servers.filter((server) => server.status === 'online' || server.status === 'warning').length
    return {
      online,
      offline: servers.filter((server) => server.status === 'offline').length,
      gpus: gpus.length,
      idle: values.reduce((sum, snapshot) => sum + snapshot.gpus.filter((gpu) => isGpuIdle(gpu, settings?.idleGpuThreshold ?? 10)).length, 0),
      gpuAverage: gpus.length ? gpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / gpus.length : 0,
      cpuAverage: values.length ? values.reduce((sum, snapshot) => sum + clampPercent(snapshot.system.cpuUtilization), 0) / values.length : 0,
      hot: gpus.filter((gpu) => gpu.temperatureCelsius > (settings?.temperatureThresholdCelsius ?? 85)).length,
      latestRefresh: values.length ? Math.max(...values.map((snapshot) => snapshot.timestamp)) : null,
    }
  }, [snapshots, servers, settings])

  async function saveServer(draft: ServerDraft) {
    const server = await api.saveServer(draft)
    deletedServerIds.current.delete(server.id)
    setServers((current) => [...current.filter((item) => item.id !== server.id), server])
    setSelectedServerId(server.id)
    setShowServerForm(false)
    setEditingServer(null)
    await refreshServer(server.id)
  }

  async function removeServer(server: Server) {
    if (!window.confirm(`删除“${server.name}”？历史数据也会一并删除。`)) return
    deletedServerIds.current.add(server.id)
    try {
      await api.deleteServer(server.id)
      const nextSelectedId = servers.find((item) => item.id !== server.id)?.id ?? null
      setServers((current) => current.filter((item) => item.id !== server.id))
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
      delete failureCounts.current[server.id]
      delete lastAttemptAt.current[server.id]
      delete lastProcessAttemptAt.current[server.id]
      delete nextRetryAt.current[server.id]
      for (const key of Object.keys(conditionSince.current)) if (key.includes(`:${server.id}:`)) delete conditionSince.current[key]
      for (const key of notifiedConditions.current) if (key.includes(`:${server.id}:`) || key === `offline:${server.id}`) notifiedConditions.current.delete(key)
    } catch (error) {
      deletedServerIds.current.delete(server.id)
      setToast(`删除服务器失败：${String(error)}`)
    }
  }

  async function importConfig() {
    try {
      const drafts = await api.importSshConfig()
      if (drafts.length === 0) {
        setToast('未在 OpenSSH Config 中找到可导入的主机')
        return
      }
      setImportDrafts(drafts)
    } catch (error) {
      setToast(String(error))
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${api.isDesktop ? 'sidebar--desktop' : ''}`}>
        <div className="traffic-spacer" aria-hidden="true" />
        <div className="brand">
          <span className="brand__mark"><Activity size={18} strokeWidth={2.4} /></span>
          <div><strong>RackTop</strong><small>算力监控</small></div>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          <button className={mainView === 'fleet' ? 'is-active' : ''} onClick={() => setMainView('fleet')}><LayoutDashboard size={17} />总览 <span className="nav-count">{totals.gpus}</span></button>
          <button className={mainView === 'idle' ? 'is-active' : ''} onClick={() => setMainView('idle')}><Zap size={17} />空闲 GPU <span className="nav-count">{totals.idle}</span></button>
        </nav>
        <div className="sidebar__section-header"><span>服务器</span><span>{totals.online}/{servers.length}</span></div>
        <div className="search-field"><Search size={14} /><input aria-label="搜索服务器" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13} /></button>}</div>
        <div className="server-list">
          {visibleServers.map((server) => {
            const snapshot = snapshots[server.id]
            return (
              <button
                className={`server-row ${selectedServerId === server.id && mainView === 'server' ? 'is-selected' : ''}`}
                key={server.id}
                onClick={() => { setSelectedServerId(server.id); setSelectedGpuUuid(null); setMainView('server') }}
              >
                <span className={`server-row__status server-row__status--${server.status}`} />
                <span className="server-row__content">
                  <span className="server-row__title">{server.name}</span>
                  <span className="server-row__meta">{snapshot ? `${snapshot.gpus.length} GPU · CPU ${Math.round(clampPercent(snapshot.system.cpuUtilization))}%` : server.host}</span>
                </span>
                {snapshot?.processes.some((process) => process.isCurrentUser) && <span className="own-task-dot" title="有你的任务"><UserRound size={11} /></span>}
                <ChevronRight size={14} className="server-row__chevron" />
              </button>
            )
          })}
          {visibleServers.length === 0 && <p className="empty-copy">没有匹配的服务器</p>}
        </div>
        <div className="sidebar__footer">
          <button onClick={() => { setEditingServer(null); setShowServerForm(true) }}><Plus size={16} />添加服务器</button>
          <button onClick={importConfig}><Download size={16} />导入 SSH Config</button>
          <button onClick={() => setShowSettings(true)}><Settings size={16} />设置</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{mainView === 'idle' ? '资源发现' : mainView === 'fleet' ? `${totals.online} / ${servers.length} 台在线` : selectedServer ? selectedServer.host : '所有服务器'}</p>
            <h1>{mainView === 'idle' ? '寻找空闲 GPU' : mainView === 'fleet' ? '所有服务器的 GPU' : selectedServer?.name ?? 'RackTop 总览'}</h1>
          </div>
          <div className="topbar__actions">
            <span className={`refresh-label ${paused ? 'is-paused' : ''}`}><Clock3 size={14} />{paused ? '采集已暂停' : mainView === 'server' && selectedServer ? relativeTime(selectedServer.lastSeenAt) : totals.latestRefresh ? relativeTime(totals.latestRefresh) : `${settings?.defaultSamplingIntervalSeconds ?? 2} 秒采样`}</span>
            <button className="button button--secondary" onClick={() => void runManualRefreshAll()} disabled={manualRefreshingAll}><RefreshCw size={16} className={manualRefreshingAll ? 'spin' : ''} />刷新全部</button>
            <button className="icon-button" aria-label="通知"><Bell size={18} />{totals.hot > 0 && <span className="notification-dot" />}</button>
          </div>
        </header>

        {servers.length === 0 ? (
          <EmptyState onAdd={() => { setEditingServer(null); setShowServerForm(true) }} onImport={importConfig} />
        ) : mainView === 'idle' ? (
          <IdleGpuView servers={servers} snapshots={snapshots} history={history} onSelect={(serverId, gpuUuid) => { setSelectedServerId(serverId); setSelectedGpuUuid(gpuUuid); setSelectedTab('gpu'); setMainView('server') }} />
        ) : mainView === 'fleet' ? (
          <FleetOverview servers={servers} snapshots={snapshots} settings={settings} totals={totals} sort={fleetSort} descending={fleetDescending} onSort={setFleetSort} onToggleOrder={() => setFleetDescending((value) => !value)} onSelect={(serverId, tab, gpuUuid) => { setSelectedServerId(serverId); setSelectedGpuUuid(gpuUuid ?? null); setSelectedTab(tab); setMainView('server') }} />
        ) : selectedServer && selectedSnapshot ? (
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
            onDelete={() => void removeServer(selectedServer)}
            onEdit={() => { setEditingServer(selectedServer); setShowServerForm(true) }}
            isRefreshing={manualRefreshingServers.has(selectedServer.id)}
            animateCharts={manualRefreshingAll || manualRefreshingServers.has(selectedServer.id)}
          />
        ) : (
          <LoadingServer server={selectedServer} isRefreshing={selectedServer ? busy.has(selectedServer.id) : false} onRefresh={() => selectedServer && void refreshServer(selectedServer.id)} />
        )}
      </main>

      {showServerForm && <ServerForm initial={editingServer ? serverToDraft(editingServer) : undefined} defaultSamplingInterval={settings?.defaultSamplingIntervalSeconds} defaultHistoryRetentionDays={settings?.historyRetentionDays} onClose={() => { setShowServerForm(false); setEditingServer(null) }} onSave={saveServer} />}
      {showSettings && settings && <SettingsSheet settings={settings} onClose={() => setShowSettings(false)} onSave={async (value) => { setSettings(await api.saveSettings(value)); setShowSettings(false); setToast('设置已保存') }} />}
      {importDrafts && <SshImportSheet drafts={importDrafts} onClose={() => setImportDrafts(null)} onImport={async (selected) => { for (const draft of selected) await api.saveServer(draft); setServers(await api.listServers()); setImportDrafts(null); setToast(`已导入 ${selected.length} 台服务器`) }} />}
      {pendingHostKey && <HostKeyDialog info={pendingHostKey} onClose={() => setPendingHostKey(null)} onTrust={async () => { const serverId = pendingHostKey.serverId; await api.trustHostKey(pendingHostKey); setPendingHostKey(null); setToast('已信任服务器指纹'); await refreshServer(serverId) }} />}
      {toast && <div className="toast" role="status"><AlertCircle size={17} /><span>{toast}</span><button onClick={() => setToast(null)} aria-label="关闭"><X size={14} /></button></div>}
    </div>
  )
}

function EmptyState({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><ServerIcon size={28} /></span>
      <h2>连接第一台服务器</h2>
      <p>添加 SSH 主机或导入现有 OpenSSH Config，RackTop 会自动采集 GPU、CPU、内存和进程指标。</p>
      <div><button className="button button--primary" onClick={onAdd}><Plus size={17} />添加服务器</button><button className="button button--secondary" onClick={onImport}><Download size={17} />导入配置</button></div>
    </div>
  )
}

function LoadingServer({ server, isRefreshing, onRefresh }: { server?: Server; isRefreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Network size={28} /></span>
      <h2>{isRefreshing ? `正在连接 ${server?.name ?? ''}` : '尚无采样数据'}</h2>
      <p>{server?.lastError ?? '通过 SSH 获取第一份指标后，这里会显示完整服务器详情。'}</p>
      <button className="button button--primary" onClick={onRefresh}><RefreshCw size={17} className={isRefreshing ? 'spin' : ''} />{isRefreshing ? '连接中…' : '立即连接'}</button>
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
  isRefreshing: boolean
  animateCharts: boolean
}

function ServerDetail({ server, snapshot, points, settings, tab, selectedGpuUuid, onTab, onSelectGpu, onRefresh, onDelete, onEdit, isRefreshing, animateCharts }: ServerDetailProps) {
  return (
    <div className="detail-page">
      <div className="server-identity">
        <div><StatusPill status={server.status} /><span className="server-identity__meta">{snapshot.username}@{snapshot.hostname} · 端口 {server.port}</span></div>
        <button className="icon-button" aria-label="编辑服务器" onClick={onEdit}><MoreHorizontal size={18} /></button>
      </div>
      <div className="detail-tabs" role="tablist">
        {tabs.map((item) => <button key={item.value} role="tab" aria-selected={tab === item.value} className={tab === item.value ? 'is-active' : ''} onClick={() => onTab(item.value)}>{item.label}</button>)}
      </div>
      <div className="detail-content">
        {snapshot.nvidiaSmi !== 'available' && <NvidiaWarning snapshot={snapshot} onRefresh={onRefresh} />}
        {tab === 'overview' && <ServerOverview snapshot={snapshot} points={points} idleThreshold={settings?.idleGpuThreshold ?? 10} onSelectGpu={onSelectGpu} onOpenCpu={() => onTab('cpu')} animateCharts={animateCharts} />}
        {tab === 'gpu' && <GpuDetail snapshot={snapshot} points={points} selectedGpuUuid={selectedGpuUuid} onSelectGpu={onSelectGpu} animateChart={animateCharts} />}
        {tab === 'cpu' && <CpuDetail snapshot={snapshot} points={points} animateChart={animateCharts} />}
        {tab === 'processes' && <ProcessTable snapshot={snapshot} />}
        {tab === 'history' && <HistoryView snapshot={snapshot} points={points} animateChart={animateCharts} />}
        {tab === 'logs' && <LogsView server={server} snapshot={snapshot} />}
        {tab === 'connection' && <ConnectionView server={server} onRefresh={onRefresh} onDelete={onDelete} onEdit={onEdit} isRefreshing={isRefreshing} />}
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

function ServerOverview({ snapshot, points, idleThreshold, onSelectGpu, onOpenCpu, animateCharts }: { snapshot: Snapshot; points: HistoryPoint[]; idleThreshold: number; onSelectGpu: (gpuUuid: string) => void; onOpenCpu: () => void; animateCharts: boolean }) {
  const totalMemoryMb = snapshot.gpus.reduce((sum, gpu) => sum + Math.max(0, gpu.memoryTotalMb), 0)
  const usedMemoryMb = snapshot.gpus.reduce((sum, gpu) => sum + Math.max(0, gpu.memoryUsedMb), 0)
  const gpuAverage = snapshot.gpus.length ? snapshot.gpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / snapshot.gpus.length : 0
  const idleCount = snapshot.gpus.filter((gpu) => isGpuIdle(gpu, idleThreshold)).length
  const systemMemoryPercent = snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0

  return <div className="overview-stack">
    <section className="metric-grid">
      <MetricCard icon={<Zap />} label="可用 GPU" value={`${idleCount} / ${snapshot.gpus.length}`} foot="显存低于 1% 且核心空闲" tone="green" />
      <MetricCard icon={<MemoryStick />} label="GPU 显存" value={`${(usedMemoryMb / 1024).toFixed(1)} GB`} foot={`共 ${(totalMemoryMb / 1024).toFixed(1)} GB`} tone="purple" />
      <MetricCard icon={<Gauge />} label="GPU 平均 UTL" value={`${gpuAverage.toFixed(1)}%`} foot={`${snapshot.gpus.length} 块 GPU`} tone={gpuLoadAccent(gpuAverage)} />
      <MetricCard icon={<TerminalSquare />} label="当前进程" value={`${snapshot.processes.length}`} foot={snapshot.processes.some((process) => process.isCurrentUser) ? '包含你的任务' : 'GPU 计算进程'} tone="orange" emphasisFoot={snapshot.processes.some((process) => process.isCurrentUser)} />
    </section>

    <section className="overview-section" aria-labelledby="overview-resource-title">
      <div className="overview-section__header"><Gauge size={17} /><div><h2 id="overview-resource-title">GPU 与 CPU 状态</h2><p>GPU 显存优先，CPU 资源并列概览</p></div></div>
      <div className="gpu-grid">{snapshot.gpus.map((gpu) => <GpuCard key={gpu.uuid} gpu={gpu} processes={snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid)} onOpen={() => onSelectGpu(gpu.uuid)} />)}<CpuOverviewCard snapshot={snapshot} memoryPercent={systemMemoryPercent} onOpen={onOpenCpu} /></div>
    </section>

    <section className="overview-section" aria-labelledby="overview-trends-title">
      <div className="overview-section__header"><Activity size={17} /><div><h2 id="overview-trends-title">实时趋势</h2><p>CPU、GPU 显存、系统内存与 Swap、GPU 核心利用率</p></div></div>
      <div className="trend-grid">
        <section className="panel panel--mini-chart"><PanelHeader title="CPU UTL" /><TrendChart points={points} snapshot={snapshot} mode="cpu" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="GPU MEM" /><TrendChart points={points} snapshot={snapshot} mode="gpuMemory" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="系统 MEM / SWP" /><TrendChart points={points} snapshot={snapshot} mode="systemMemory" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="GPU UTL" /><TrendChart points={points} snapshot={snapshot} mode="gpu" height={170} animate={animateCharts} /></section>
      </div>
    </section>

    <section className="overview-section" aria-labelledby="overview-process-title">
      <div className="overview-section__header"><TerminalSquare size={17} /><div><h2 id="overview-process-title">当前进程</h2><p>正在使用 GPU 的计算任务</p></div></div>
      <ProcessTable snapshot={snapshot} />
    </section>
  </div>
}

function GpuCard({ gpu, processes, onOpen }: { gpu: Snapshot['gpus'][number]; processes: Snapshot['processes']; onOpen: () => void }) {
  const memoryPercent = gpuMemoryPercent(gpu)
  const displayedMemoryPercent = displayedGpuMemoryPercent(memoryPercent)
  const memoryLevel = gpuMemoryLevel(memoryPercent)
  const ownMemoryMb = processes.filter((process) => process.isCurrentUser).reduce((sum, process) => sum + process.memoryUsedMb, 0)
  const ownMemoryPercent = gpu.memoryTotalMb ? ownMemoryMb / gpu.memoryTotalMb * 100 : 0
  return (
    <button className={`panel gpu-card gpu-card--${memoryLevel}`} onClick={onOpen}>
      <PanelHeader title={`GPU ${gpu.index}`} subtitle={gpu.name.replace('NVIDIA ', '')} action={<ChevronRight size={16} />} />
      <MetricBar label="MEM" value={displayedMemoryPercent} detail={`${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(0)} GB`} accent="purple" currentUserValue={ownMemoryPercent} />
      <MetricBar label="UTL" value={clampPercent(gpu.utilization)} accent={gpuLoadAccent(gpu.utilization)} />
      <div className="gpu-card__footer"><span><HardDrive size={14} />MBW {clampPercent(gpu.memoryUtilization).toFixed(0)}%</span><span><Zap size={14} />{gpu.powerWatts.toFixed(0)} W</span><span><Activity size={14} />{gpu.temperatureCelsius}°C</span><span><Box size={14} />{processes.length} 进程</span>{ownMemoryMb > 0 && <span className="gpu-card__own"><UserRound size={13} />你 {(ownMemoryMb / 1024).toFixed(1)} GB</span>}</div>
    </button>
  )
}

function CpuOverviewCard({ snapshot, memoryPercent, onOpen }: { snapshot: Snapshot; memoryPercent: number; onOpen: () => void }) {
  return (
    <button className="panel gpu-card cpu-overview-card" onClick={onOpen}>
      <PanelHeader title="CPU" subtitle="系统资源" action={<ChevronRight size={16} />} />
      <MetricBar label="系统 MEM" value={memoryPercent} detail={`${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`} accent="purple" />
      <MetricBar label="CPU UTL" value={snapshot.system.cpuUtilization} currentUserValue={snapshot.system.currentUserCpuUtilization} />
      <div className="gpu-card__footer"><span><Activity size={14} />1m {snapshot.system.load1.toFixed(2)}</span><span><Clock3 size={14} />5m {snapshot.system.load5.toFixed(2)}</span><span><Clock3 size={14} />15m {snapshot.system.load15.toFixed(2)}</span><span><HardDrive size={14} />Swap {formatBytes(snapshot.system.swapUsedBytes)}</span></div>
    </button>
  )
}

function GpuDetail({ snapshot, points, selectedGpuUuid, onSelectGpu, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; selectedGpuUuid: string | null; onSelectGpu: (gpuUuid: string) => void; animateChart: boolean }) {
  const orderedGpus = snapshot.gpus
  return <div className="content-stack">
    <section className="panel panel--chart"><PanelHeader icon={<Gauge />} title="GPU 利用率" subtitle="实时窗口内的设备趋势" /><TrendChart points={points} snapshot={snapshot} mode="gpu" height={300} animate={animateChart} /></section>
    <section className="gpu-detail-list">{orderedGpus.map((gpu) => {
      const gpuProcesses = snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid)
      const ownMemoryMb = gpuProcesses.filter((process) => process.isCurrentUser).reduce((sum, process) => sum + process.memoryUsedMb, 0)
      const memory = gpuMemoryPercent(gpu)
      return <button type="button" className={`panel gpu-detail gpu-detail--${gpuMemoryLevel(memory)} ${gpu.uuid === selectedGpuUuid ? 'is-selected' : ''}`} aria-pressed={gpu.uuid === selectedGpuUuid} key={gpu.uuid} onClick={() => onSelectGpu(gpu.uuid)}>
        <div className="gpu-detail__title"><div><span>GPU {gpu.index}{gpu.uuid === selectedGpuUuid ? ' · 已选中' : ''}</span><h3>{gpu.name}</h3><small>{gpu.uuid}</small></div><strong>{displayedGpuMemoryPercent(memory)}%<small> MEM</small></strong></div>
        <div className="gpu-detail__meters"><MetricBar label="MEM" value={displayedGpuMemoryPercent(memory)} detail={`${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB`} accent="purple" /><MetricBar label="UTL" value={gpu.utilization} accent={gpuLoadAccent(gpu.utilization)} /></div>
        <div className="stat-row"><span><small>MBW</small><strong>{clampPercent(gpu.memoryUtilization).toFixed(0)}%</strong></span><span><small>温度</small><strong>{gpu.temperatureCelsius}°C</strong></span><span><small>功耗</small><strong>{gpu.powerWatts.toFixed(1)} W</strong></span><span><small>进程</small><strong>{gpuProcesses.length}</strong></span></div>
        {ownMemoryMb > 0 && <div className="gpu-detail__own"><UserRound size={13} /><strong>你的任务</strong><span>占用 {(ownMemoryMb / 1024).toFixed(1)} GB 显存</span></div>}
      </button>
    })}</section>
  </div>
}

function CpuDetail({ snapshot, points, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; animateChart: boolean }) {
  const memoryPercent = snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0
  return <div className="content-stack"><section className="panel panel--chart"><PanelHeader icon={<Cpu />} title="CPU 利用率" subtitle={`当前用户 ${snapshot.system.currentUserCpuUtilization.toFixed(1)}%`} /><TrendChart points={points} snapshot={snapshot} mode="cpu" height={300} animate={animateChart} /></section><section className="panel system-resource-panel"><PanelHeader icon={<MemoryStick />} title="系统资源" /><div className="resource-bars"><MetricBar label="CPU" value={snapshot.system.cpuUtilization} currentUserValue={snapshot.system.currentUserCpuUtilization} /><MetricBar label="内存" value={memoryPercent} detail={`${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`} accent="purple" /></div><div className="stat-row stat-row--border"><span><small>1 分钟负载</small><strong>{snapshot.system.load1.toFixed(2)}</strong></span><span><small>5 分钟负载</small><strong>{snapshot.system.load5.toFixed(2)}</strong></span><span><small>15 分钟负载</small><strong>{snapshot.system.load15.toFixed(2)}</strong></span><span><small>Swap</small><strong>{formatBytes(snapshot.system.swapUsedBytes)}</strong></span></div></section></div>
}

function ProcessTable({ snapshot }: { snapshot: Snapshot }) {
  const [selectedPid, setSelectedPid] = useState<number | null>(null)
  const selectedProcess = snapshot.processes.find((process) => process.pid === selectedPid)
  return <div className="content-stack"><section className="panel process-panel"><PanelHeader icon={<TerminalSquare />} title="GPU 进程" subtitle={`${snapshot.processes.length} 个计算进程 · 点击查看详情`} />{snapshot.processes.length ? <div className="table-scroll"><table><thead><tr><th>GPU</th><th>PID</th><th>用户</th><th>命令</th><th>GPU 显存</th><th>CPU</th><th>运行时间</th></tr></thead><tbody>{snapshot.processes.map((process) => <tr key={`${process.gpuUuid}-${process.pid}`} tabIndex={0} aria-selected={process.pid === selectedPid} className={`${process.isCurrentUser ? 'is-current-user' : ''} ${process.pid === selectedPid ? 'is-selected' : ''}`} onClick={() => setSelectedPid(process.pid)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedPid(process.pid) } }}><td>GPU {process.gpuIndex}</td><td className="mono">{process.pid}</td><td>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</td><td className="process-command" title={process.command}>{process.command}</td><td>{process.memoryUsedMb} MB</td><td>{process.cpuPercent.toFixed(1)}%</td><td>{process.elapsed}</td></tr>)}</tbody></table></div> : <div className="inline-empty"><CheckCircle2 size={24} /><strong>当前没有 GPU 计算进程</strong><p>所有 GPU 都处于空闲状态。</p></div>}</section>{selectedProcess && <section className="panel process-inspector" aria-label={`进程 ${selectedProcess.pid} 详情`}><PanelHeader icon={<TerminalSquare />} title={`进程 ${selectedProcess.pid}`} subtitle={selectedProcess.isCurrentUser ? '当前 SSH 用户的任务' : `${selectedProcess.username} 的任务`} action={<button className="icon-button" aria-label="关闭进程详情" onClick={() => setSelectedPid(null)}><X size={15} /></button>} /><dl className="definition-list"><div><dt>GPU</dt><dd>GPU {selectedProcess.gpuIndex}</dd></div><div><dt>用户</dt><dd>{selectedProcess.isCurrentUser && <span className="own-label">你</span>}{selectedProcess.username}</dd></div><div><dt>显存</dt><dd>{selectedProcess.memoryUsedMb} MB</dd></div><div><dt>CPU</dt><dd>{selectedProcess.cpuPercent.toFixed(1)}%</dd></div><div><dt>运行时间</dt><dd>{selectedProcess.elapsed}</dd></div><div><dt>命令</dt><dd className="mono process-inspector__command">{selectedProcess.command}</dd></div></dl></section>}</div>
}

function HistoryView({ snapshot, points, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; animateChart: boolean }) {
  const rangeMinutes = points.length > 1 ? Math.max(1, Math.round((points[points.length - 1].timestamp - points[0].timestamp) / 60)) : 0
  return <div className="content-stack"><section className="panel panel--chart"><PanelHeader icon={<History />} title="历史趋势" subtitle={rangeMinutes ? `当前载入 ${rangeMinutes} 分钟` : '等待历史样本'} /><TrendChart points={points} snapshot={snapshot} height={340} animate={animateChart} /></section><section className="panel data-retention"><Database size={20} /><div><strong>本地历史数据</strong><p>样本按设置的保存时间自动清理，敏感凭据不会写入 SQLite。</p></div></section></div>
}

function LogsView({ server, snapshot }: { server: Server; snapshot: Snapshot }) {
  const items = [{ level: 'success', time: snapshot.timestamp, message: `采集成功：${snapshot.gpus.length} GPU，${snapshot.processes.length} 个进程` }, ...(server.lastError ? [{ level: 'error', time: snapshot.timestamp, message: server.lastError }] : [])]
  return <section className="panel logs-panel"><PanelHeader icon={<ListFilter />} title="采集与连接日志" subtitle={`${items.length} 条最近记录`} /><div className="log-list">{items.map((item, index) => <div className={`log-row log-row--${item.level}`} key={index}><span aria-hidden="true" /><time dateTime={new Date(item.time * 1000).toISOString()}>{new Date(item.time * 1000).toLocaleTimeString()}</time><p>{item.message}</p></div>)}</div></section>
}

function ConnectionView({ server, onRefresh, onDelete, onEdit, isRefreshing }: { server: Server; onRefresh: () => void; onDelete: () => void; onEdit: () => void; isRefreshing: boolean }) {
  return <div className="content-stack"><section className="panel connection-panel"><PanelHeader icon={<KeyRound />} title="SSH 连接" subtitle="认证信息仅在本机使用" /><dl className="definition-list"><div><dt>地址</dt><dd className="mono">{server.username}@{server.host}:{server.port}</dd></div><div><dt>认证</dt><dd>{server.authMethod === 'sshAgent' ? 'SSH Agent / 默认密钥' : server.authMethod}</dd></div><div><dt>SSH Config</dt><dd>{server.sshAlias || '未使用别名'}</dd></div><div><dt>私钥</dt><dd className="mono">{server.identityFile || '由 OpenSSH 自动选择'}</dd></div><div><dt>ProxyJump</dt><dd className="mono">{server.proxyJump || '无'}</dd></div></dl><div className="panel__actions"><button className="button button--primary" onClick={onRefresh} disabled={isRefreshing}><RefreshCw size={16} className={isRefreshing ? 'spin' : ''} />测试并重新连接</button><button className="button button--secondary" onClick={onEdit}><Settings size={16} />编辑配置</button></div></section><section className="panel danger-zone"><div><strong>删除服务器</strong><p>同时移除该服务器在本机保存的历史数据。</p></div><button className="button button--danger" onClick={onDelete}><Trash2 size={16} />删除</button></section></div>
}

function NvidiaWarning({ snapshot, onRefresh }: { snapshot: Snapshot; onRefresh: () => void }) {
  const [hidden, setHidden] = useState(false)
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const command = snapshot.osId === 'ubuntu' ? 'sudo apt update && sudo apt install -y ubuntu-drivers-common && sudo ubuntu-drivers autoinstall' : snapshot.osId === 'debian' ? 'sudo apt update && sudo apt install -y nvidia-driver' : 'command -v nvidia-smi || echo "请参考 NVIDIA 官方驱动文档安装适合当前发行版的驱动"'
  if (hidden) return null
  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(command); setMessage('安装命令已复制') } catch { setMessage('无法访问剪贴板，请手动选择命令复制') }
  }
  const install = async () => {
    if (!window.confirm(`RackTop 将在 ${snapshot.osName} 上安装 NVIDIA 驱动包。继续吗？`)) return
    if (!window.confirm('该操作会通过 sudo 修改服务器软件包，且可能需要重启。确认执行？')) return
    setWorking(true)
    try { setMessage(await api.installNvidiaDriver(snapshot.serverId)) } catch (error) { setMessage(String(error)) } finally { setWorking(false) }
  }
  const supported = snapshot.osId === 'ubuntu' || snapshot.osId === 'debian'
  return <section className="nvidia-warning"><AlertCircle size={20} /><div><strong>无法使用 NVIDIA GPU 监控</strong><p>{snapshot.nvidiaMessage || '服务器上未检测到可执行的 nvidia-smi。CPU 与内存监控仍会继续。'}</p><small>检测到：{snapshot.osName}</small><details open><summary>适用的安装命令</summary><code>{command}</code><small>驱动安装通常需要重启。自动安装只支持 Ubuntu / Debian，并且必须通过两次确认。</small></details>{message && <p className="nvidia-warning__message" role="status">{message}</p>}<div className="nvidia-warning__actions">{supported && <button className="button button--primary button--small" disabled={working} onClick={() => void install()}>{working ? '安装中…' : '帮助安装'}</button>}<button className="button button--secondary button--small" onClick={() => void copyCommand()}>复制命令</button><button className="button button--secondary button--small" onClick={onRefresh}>重新检测</button><button className="button button--secondary button--small" onClick={() => setHidden(true)}>暂不处理</button></div></div></section>
}

interface FleetTotals {
  online: number
  offline: number
  gpus: number
  idle: number
  gpuAverage: number
  cpuAverage: number
  hot: number
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

function FleetOverview({ servers, snapshots, settings, totals, sort, descending, onSort, onToggleOrder, onSelect }: { servers: Server[]; snapshots: Record<string, Snapshot>; settings: AppSettings | null; totals: FleetTotals; sort: 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount'; descending: boolean; onSort: (sort: 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount') => void; onToggleOrder: () => void; onSelect: (serverId: string, tab: DetailTab, gpuUuid?: string) => void }) {
  const metric = (server: Server) => {
    const snapshot = snapshots[server.id]
    const average = snapshot?.gpus.length ? snapshot.gpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / snapshot.gpus.length : -1
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
    <div className="fleet-toolbar">
      <section className="fleet-summary" aria-label="全局资源摘要">
        <span><ServerIcon size={16} /><strong>{totals.online}</strong><small>在线服务器</small></span>
        <span><WifiOff size={16} /><strong>{totals.offline}</strong><small>离线服务器</small></span>
        <span><Gauge size={16} /><strong>{totals.gpus}</strong><small>GPU 总数</small></span>
        <span><Activity size={16} /><strong>{totals.gpuAverage.toFixed(1)}%</strong><small>平均 GPU</small></span>
        <span><Cpu size={16} /><strong>{totals.cpuAverage.toFixed(1)}%</strong><small>平均 CPU</small></span>
        <span><Zap size={16} /><strong>{totals.idle}</strong><small>空闲 GPU</small></span>
        <span><AlertCircle size={16} /><strong>{totals.hot}</strong><small>温度异常</small></span>
        <span><Clock3 size={16} /><strong>{relativeTime(totals.latestRefresh)}</strong><small>最近刷新</small></span>
      </section>
      <div className="sort-controls"><ArrowDownUp size={14} /><label><span>排序</span><select value={sort} onChange={(event) => onSort(event.target.value as typeof sort)}><option value="name">服务器名称</option><option value="status">在线状态</option><option value="gpuCount">GPU 数量</option><option value="utilization">平均利用率</option><option value="idleCount">空闲 GPU 数</option></select></label><button className="button button--secondary button--small" onClick={onToggleOrder}>{descending ? '降序' : '升序'}</button></div>
    </div>
    <section className="fleet-grid" aria-label="服务器 GPU 状态墙">
      {orderedServers.map((server) => {
        const snapshot = snapshots[server.id]
        return <MasonryItem key={server.id}><article className={`panel fleet-card fleet-card--${server.status}`}>
          <button className="fleet-card__header" onClick={() => onSelect(server.id, 'overview')}>
            <span className={`server-row__status server-row__status--${server.status}`} />
            <span><strong>{server.name}</strong><small>{snapshot ? `${snapshot.username}@${snapshot.hostname}` : `${server.username}@${server.host}`}</small></span>
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

function IdleGpuView({ servers, snapshots, history, onSelect }: { servers: Server[]; snapshots: Record<string, Snapshot>; history: Record<string, HistoryPoint[]>; onSelect: (serverId: string, gpuUuid: string) => void }) {
  const defaults = { gpuMemoryGb: 0, cpuMemoryGb: 0, duration: 0 }
  const [gpuMemoryInput, setGpuMemoryInput] = useState(String(defaults.gpuMemoryGb))
  const [cpuMemoryInput, setCpuMemoryInput] = useState(String(defaults.cpuMemoryGb))
  const [otherUserProcess, setOtherUserProcess] = useState<'all' | 'without'>('without')
  const [duration, setDuration] = useState(defaults.duration)
  const [gpuModel, setGpuModel] = useState('all')
  const [cpuModel, setCpuModel] = useState('all')
  const [tag, setTag] = useState('all')
  const gpuMemoryGb = gpuMemoryInput.trim() === '' ? defaults.gpuMemoryGb : Math.max(0, Number(gpuMemoryInput) || 0)
  const cpuMemoryGb = cpuMemoryInput.trim() === '' ? defaults.cpuMemoryGb : Math.max(0, Number(cpuMemoryInput) || 0)
  const gpuModels = Array.from(new Set(Object.values(snapshots).flatMap((snapshot) => snapshot.gpus.map((gpu) => gpu.name)))).sort()
  const cpuModels = Array.from(new Set(Object.values(snapshots).map((snapshot) => snapshot.system.cpuModel || '未知 CPU'))).sort()
  const tags = Array.from(new Set(servers.flatMap((server) => server.tags))).sort()
  const items = servers.flatMap((server) => (snapshots[server.id]?.gpus ?? []).map((gpu) => ({ server, gpu }))).filter(({ server, gpu }) => {
    const snapshot = snapshots[server.id]
    if (gpuModel !== 'all' && gpu.name !== gpuModel) return false
    if (cpuModel !== 'all' && (snapshot?.system.cpuModel || '未知 CPU') !== cpuModel) return false
    return tag === 'all' || server.tags.includes(tag)
  }).map(({ server, gpu }) => {
    const snapshot = snapshots[server.id]
    const freeCpuMemoryMb = Math.max(0, ((snapshot?.system.memoryTotalBytes ?? 0) - (snapshot?.system.memoryUsedBytes ?? 0)) / 1024 ** 2)
    const occupiedByOtherUser = hasOtherUserGpuWorkload(gpu, snapshot?.processes ?? [])
    const meetsProcess = otherUserProcess === 'all' || !occupiedByOtherUser
    const meetsSnapshot = hasEnoughFreeGpuMemory(gpu, gpuMemoryGb * 1024) && freeCpuMemoryMb >= cpuMemoryGb * 1024 && meetsProcess
    if (duration <= 0) return { server, gpu, available: meetsSnapshot }
    const snapshotTime = snapshot?.timestamp ?? Math.floor(Date.now() / 1000)
    const cutoff = snapshotTime - duration * 60
    const points = (history[server.id] ?? []).filter((point) => point.timestamp >= cutoff && point.timestamp <= snapshotTime)
    const coversWindow = points.length >= 2 && points[0].timestamp <= cutoff + Math.max(60, server.samplingIntervalSeconds * 3)
    const gpuTotalMb = Math.max(0, gpu.memoryTotalMb)
    const cpuTotalMb = Math.max(0, (snapshot?.system.memoryTotalBytes ?? 0) / 1024 ** 2)
    const meetsDuration = coversWindow && points.every((point) => {
      const historicalGpuFreeMb = gpuTotalMb * (1 - clampPercent(point.gpuMemoryUtilizations?.[gpu.uuid] ?? gpuMemoryPercent(gpu)) / 100)
      const historicalCpuFreeMb = cpuTotalMb * (1 - clampPercent(point.memoryUtilization) / 100)
      return historicalGpuFreeMb >= gpuMemoryGb * 1024 && historicalCpuFreeMb >= cpuMemoryGb * 1024
    })
    return { server, gpu, available: meetsSnapshot && meetsDuration }
  }).sort((left, right) => Number(right.available) - Number(left.available) || (right.gpu.memoryTotalMb - right.gpu.memoryUsedMb) - (left.gpu.memoryTotalMb - left.gpu.memoryUsedMb) || ((snapshots[right.server.id]?.system.memoryTotalBytes ?? 0) - (snapshots[right.server.id]?.system.memoryUsedBytes ?? 0)) - ((snapshots[left.server.id]?.system.memoryTotalBytes ?? 0) - (snapshots[left.server.id]?.system.memoryUsedBytes ?? 0)))
  const availableCount = items.filter((item) => item.available).length
  const reset = () => { setGpuMemoryInput(String(defaults.gpuMemoryGb)); setCpuMemoryInput(String(defaults.cpuMemoryGb)); setOtherUserProcess('without'); setGpuModel('all'); setCpuModel('all'); setDuration(defaults.duration); setTag('all') }

  return <div className="detail-page idle-page">
    <section className="idle-filters" aria-label="空闲 GPU 筛选条件">
      <header><div><SlidersHorizontal size={17} /><div><strong>空闲条件</strong><small>仅检测其他用户；系统显示进程与不超过 GPU MEM 3% 的小占用不计入</small></div></div><button className="button button--secondary button--small" onClick={reset}><RotateCcw size={13} />重置</button></header>
      <div className="idle-filter-grid">
        <label>GPU MEM 至少<div><input inputMode="decimal" type="number" min="0" step="1" value={gpuMemoryInput} onChange={(event) => setGpuMemoryInput(event.target.value)} onBlur={() => setGpuMemoryInput(String(gpuMemoryGb))} /><span>GB</span></div></label>
        <label>CPU MEM 至少<div><input inputMode="decimal" type="number" min="0" step="1" value={cpuMemoryInput} onChange={(event) => setCpuMemoryInput(event.target.value)} onBlur={() => setCpuMemoryInput(String(cpuMemoryGb))} /><span>GB</span></div></label>
        <label>进程占用<select value={otherUserProcess} onChange={(event) => setOtherUserProcess(event.target.value as 'all' | 'without')}><option value="without">无人占用</option><option value="all">不限</option></select></label>
        <label>GPU 型号<select value={gpuModel} onChange={(event) => setGpuModel(event.target.value)}><option value="all">全部型号</option>{gpuModels.map((item) => <option value={item} key={item}>{item.replace('NVIDIA ', '')}</option>)}</select></label>
        <label>CPU 型号<select value={cpuModel} onChange={(event) => setCpuModel(event.target.value)}><option value="all">全部型号</option>{cpuModels.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label>持续时间<select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value="0">当前快照</option><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></label>
        <label>服务器标签<select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">全部标签</option>{tags.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
      </div>
      <footer><span>GPU MEM ≥ {gpuMemoryGb} GB</span><span>CPU MEM ≥ {cpuMemoryGb} GB</span><span>{otherUserProcess === 'all' ? '进程占用：不限' : '无人占用'}</span><span>{duration ? `MEM 持续 ${duration} 分钟` : '当前快照'}</span><strong>{availableCount} 张可用 · {items.length - availableCount} 张不可用</strong></footer>
    </section>
    <section className="idle-grid">{items.map(({ server, gpu, available }) => {
      const snapshot = snapshots[server.id]
      const freeCpuGb = Math.max(0, ((snapshot?.system.memoryTotalBytes ?? 0) - (snapshot?.system.memoryUsedBytes ?? 0)) / 1024 ** 3)
      const occupiedByOtherUser = hasOtherUserGpuWorkload(gpu, snapshot?.processes ?? [])
      return <button className={`panel idle-card ${available ? '' : 'idle-card--unavailable'}`} key={`${server.id}-${gpu.uuid}`} onClick={() => onSelect(server.id, gpu.uuid)}><div className="idle-card__top"><span className={`idle-badge ${available ? '' : 'idle-badge--unavailable'}`}>{available ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{available ? '可用' : '不可用'}</span><ChevronRight size={16} /></div><h3>{server.name} · GPU {gpu.index}</h3><p>{gpu.name} · {snapshot?.system.cpuModel || '未知 CPU'}</p><div className="idle-card__stats"><span><strong>{((gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} GB</strong><small>GPU MEM</small></span><span><strong>{freeCpuGb.toFixed(1)} GB</strong><small>CPU MEM</small></span><span><strong>{occupiedByOtherUser ? '有' : '无'}</strong><small>进程占用</small></span></div><div className="tag-row">{server.tags.map((item) => <span key={item}>{item}</span>)}</div></button>
    })}{items.length === 0 && <div className="inline-empty inline-empty--wide"><WifiOff size={28} /><strong>没有对应范围的 GPU</strong><p>当前没有符合所选 GPU 型号、CPU 型号或服务器标签的设备。</p></div>}</section>
  </div>
}

function SettingsSheet({ settings, onClose, onSave }: { settings: AppSettings; onClose: () => void; onSave: (settings: AppSettings) => Promise<void> }) {
  const [value, setValue] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof AppSettings>(key: K, next: AppSettings[K]) => setValue((current) => ({ ...current, [key]: next }))
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header className="sheet__header"><div><p className="eyebrow">偏好设置</p><h2 id="settings-title">采样、历史与外观</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="settings-body"><SettingsGroup icon={<RefreshCw />} title="采样"><label>新服务器默认采样 <span>{value.defaultSamplingIntervalSeconds} 秒</span><input type="range" min="2" max="30" value={value.defaultSamplingIntervalSeconds} onChange={(event) => set('defaultSamplingIntervalSeconds', Number(event.target.value))} /></label><label>后台最低采样间隔 <span>{value.backgroundSamplingIntervalSeconds} 秒</span><input type="range" min="5" max="120" value={value.backgroundSamplingIntervalSeconds} onChange={(event) => set('backgroundSamplingIntervalSeconds', Number(event.target.value))} /></label><label>GPU 进程刷新 <select value={value.processIntervalSeconds} onChange={(event) => set('processIntervalSeconds', Number(event.target.value))}><option value="2">2 秒</option><option value="5">5 秒</option><option value="10">10 秒</option><option value="30">30 秒</option></select></label><label>实时趋势窗口 <span>{value.realtimeWindowMinutes} 分钟</span><input type="range" min="10" max="360" step="10" value={value.realtimeWindowMinutes} onChange={(event) => set('realtimeWindowMinutes', Number(event.target.value))} /></label></SettingsGroup><SettingsGroup icon={<Database />} title="历史"><label className="switch-row"><span><strong>保存历史数据</strong><small>使用本地 SQLite，按每台服务器的策略自动清理</small></span><input type="checkbox" checked={value.historyEnabled} onChange={(event) => set('historyEnabled', event.target.checked)} /></label><label>新服务器默认保存时间 <select disabled={!value.historyEnabled} value={value.historyRetentionDays} onChange={(event) => set('historyRetentionDays', Number(event.target.value))}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select></label></SettingsGroup><SettingsGroup icon={<CircleGauge />} title="空闲与告警"><label>空闲 GPU 阈值 <span>{value.idleGpuThreshold}%</span><input type="range" min="0" max="30" value={value.idleGpuThreshold} onChange={(event) => set('idleGpuThreshold', Number(event.target.value))} /></label><label>空闲通知持续时间 <select value={value.idleDurationMinutes} onChange={(event) => set('idleDurationMinutes', Number(event.target.value))}><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="30">30 分钟</option><option value="60">1 小时</option></select></label><label>显存释放阈值 <span>{(value.idleMemoryThresholdMb / 1024).toFixed(0)} GB</span><input type="range" min="0" max="163840" step="4096" value={value.idleMemoryThresholdMb} onChange={(event) => set('idleMemoryThresholdMb', Number(event.target.value))} /></label><label>温度告警 <span>{value.temperatureThresholdCelsius}°C</span><input type="range" min="60" max="95" value={value.temperatureThresholdCelsius} onChange={(event) => set('temperatureThresholdCelsius', Number(event.target.value))} /></label></SettingsGroup><SettingsGroup icon={<SlidersHorizontal />} title="外观"><label>主题<select value={value.theme} onChange={(event) => set('theme', event.target.value as AppSettings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label>个人占用强调色<input type="color" value={value.currentUserAccent} onChange={(event) => set('currentUserAccent', event.target.value)} /></label><label className="switch-row"><span><strong>减少非必要动效</strong><small>也会自动尊重系统“减少动态效果”设置</small></span><input type="checkbox" checked={value.reduceMotion} onChange={(event) => set('reduceMotion', event.target.checked)} /></label></SettingsGroup>{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={saving} onClick={async () => { setSaving(true); setError(null); try { await onSave(value) } catch (reason) { setError(String(reason)) } finally { setSaving(false) } }}>{saving ? '保存中…' : '保存设置'}</button></footer></section></div>
}

function SettingsGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <section className="settings-group"><header><span>{icon}</span><h3>{title}</h3></header><div>{children}</div></section>
}

function SshImportSheet({ drafts, onClose, onImport }: { drafts: ServerDraft[]; onClose: () => void; onImport: (drafts: ServerDraft[]) => Promise<void> }) {
  const [selected, setSelected] = useState(() => new Set(drafts.map((_, index) => index)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (index: number) => setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet import-sheet" role="dialog" aria-modal="true" aria-labelledby="ssh-import-title"><header className="sheet__header"><div><p className="eyebrow">OpenSSH Config</p><h2 id="ssh-import-title">选择要监控的服务器</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="import-list">{drafts.map((draft, index) => <label className="import-row" key={`${draft.sshAlias}-${draft.host}`}><input type="checkbox" checked={selected.has(index)} onChange={() => toggle(index)} /><span><strong>{draft.sshAlias || draft.name}</strong><small>{draft.username}@{draft.host}:{draft.port}{draft.proxyJump ? ` · via ${draft.proxyJump}` : ''}</small></span></label>)}{error && <p className="form-error" role="alert">{error}</p>}</div><footer className="sheet__footer"><span className="sheet__selection-count">已选 {selected.size} / {drafts.length}</span><button className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={saving || selected.size === 0} onClick={async () => { setSaving(true); setError(null); try { await onImport(drafts.filter((_, index) => selected.has(index))) } catch (reason) { setError(String(reason)) } finally { setSaving(false) } }}>{saving ? '导入中…' : `导入 ${selected.size} 台`}</button></footer></section></div>
}

function HostKeyDialog({ info, onClose, onTrust }: { info: HostKeyInfo; onClose: () => void; onTrust: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  return <div className="scrim"><section className={`sheet host-key-sheet ${info.changed ? 'host-key-sheet--changed' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="host-key-title"><header className="sheet__header"><div><p className="eyebrow">{info.changed ? 'SSH 安全警告' : '首次 SSH 连接'}</p><h2 id="host-key-title">{info.changed ? '服务器 Host Key 已变化' : '核对服务器指纹'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="host-key-body"><span className="host-key-icon"><ShieldAlert size={26} /></span><p>{info.changed ? <>RackTop 检测到 <strong>{info.host}</strong> 的密钥与本机记录不一致。这可能是服务器重装，也可能是中间人攻击。</> : <>这是 RackTop 第一次连接 <strong>{info.host}</strong>。请通过可信渠道与服务器管理员核对以下指纹。</>}</p><div className="fingerprint"><small>{info.algorithm}</small><code>{info.fingerprint}</code></div><p className="host-key-note">{info.changed ? '连接已被阻止。请先通过独立可信渠道核实新指纹，再使用系统 ssh-keygen 手动移除旧记录；RackTop 不会覆盖现有密钥。' : '只有在确认指纹一致后才继续。RackTop 不会自动接受未知 Host Key。'}</p></div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>{info.changed ? '保持阻止' : '取消连接'}</button>{!info.changed && <button className="button button--primary" disabled={saving} onClick={async () => { setSaving(true); try { await onTrust() } finally { setSaving(false) } }}>{saving ? '保存中…' : '指纹一致，信任并连接'}</button>}</footer></section></div>
}

export default App
