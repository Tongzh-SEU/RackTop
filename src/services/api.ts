import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { AppSettings, HistoryHeatmapPoint, HistoryPoint, HostKeyInfo, IdleReservation, InteractionLogSummary, InteractionServerSummary, RemoteCleanupResult, RemoteCleanupSweepResult, RemoteHistorySyncResult, Server, ServerDraft, Snapshot, UsageDistribution } from '../types/models'
import { clampPercent, gpuMemoryPercent } from '../utils/gpu'
import { RACKTOP_MANAGED_IDENTITY_PATH } from '../utils/sshSetup'

const isTauri = '__TAURI_INTERNALS__' in window

const now = Math.floor(Date.now() / 1000)
const demoServers: Server[] = [
  {
    id: 'demo-233',
    name: 'gpu-server-233',
    location: '计算中心 3 楼 · R2 机架',
    host: '10.201.37.233',
    port: 22,
    username: 'tongzh',
    tags: ['lab', '4090D'],
    samplingIntervalSeconds: 2,
    historyRetentionDays: 30,
    remoteHistoryEnabled: false,
    sortOrder: 0,
    authMethod: 'privateKey',
    identityFile: RACKTOP_MANAGED_IDENTITY_PATH,
    status: 'online',
    lastSeenAt: now,
  },
  {
    id: 'demo-132',
    name: 'a100-server-132',
    location: '实验室 301 · A12 机位',
    host: '10.201.127.132',
    port: 22,
    username: 'tongzh',
    tags: ['lab', 'A100'],
    samplingIntervalSeconds: 2,
    historyRetentionDays: 30,
    remoteHistoryEnabled: false,
    sortOrder: 1,
    authMethod: 'privateKey',
    identityFile: RACKTOP_MANAGED_IDENTITY_PATH,
    status: 'online',
    lastSeenAt: now,
  },
]

const defaultSettings: AppSettings = {
  defaultSamplingIntervalSeconds: 2,
  backgroundSamplingIntervalSeconds: 15,
  processIntervalSeconds: 5,
  realtimeWindowMinutes: 30,
  historyEnabled: true,
  historyRetentionDays: 90,
  idleGpuThreshold: 10,
  idleMemoryThresholdMb: 40960,
  idleDurationMinutes: 10,
  temperatureThresholdCelsius: 85,
  currentUserAccent: '#0a84ff',
  theme: 'system',
  reduceMotion: false,
  showAddServerGuide: true,
}

const demoSnapshot: Snapshot = {
  serverId: 'demo-233',
  hostname: 'gpu-server-233',
  username: 'tongzh',
  osId: 'ubuntu',
  osName: 'Ubuntu Linux',
  timestamp: now,
  status: 'online',
  system: {
    cpuModel: 'Intel Xeon Gold 6430',
    cpuUtilization: 13.8,
    currentUserCpuUtilization: 5.2,
    load1: 0.06,
    load5: 0.11,
    load15: 0.09,
    memoryUsedBytes: 12_693_184_512,
    memoryTotalBytes: 132_553_027_584,
    swapUsedBytes: 0,
    swapTotalBytes: 0,
  },
  gpus: [
    { index: 0, uuid: 'GPU-9e1c', name: 'NVIDIA GeForce RTX 4090 D', utilization: 0, memoryUtilization: 0, memoryUsedMb: 3, memoryTotalMb: 24564, temperatureCelsius: 48, powerWatts: 11.75 },
    { index: 1, uuid: 'GPU-d3f2', name: 'NVIDIA GeForce RTX 4090 D', utilization: 0, memoryUtilization: 0, memoryUsedMb: 15, memoryTotalMb: 24564, temperatureCelsius: 45, powerWatts: 18.81 },
  ],
  disks: [
    { mountPoint: '/', usedBytes: 386 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3, availableBytes: 638 * 1024 ** 3, currentUserUsedBytes: 82 * 1024 ** 3 },
  ],
  processes: [
    { gpuUuid: 'GPU-9e1c', gpuIndex: 0, pid: 42861, parentPid: 1, username: 'tongzh', command: 'python train.py --config configs/llama3-8b.yaml --devices 0', memoryUsedMb: 18432, smUtilization: 76, cpuPercent: 18.2, elapsed: '01:42:18', isCurrentUser: true, isGroupLeader: true },
  ],
  cpuProcesses: [],
  processesSampled: true,
  nvidiaSmi: 'available',
}

const a100Snapshot: Snapshot = {
  serverId: 'demo-132',
  hostname: 'ubuntu-R8428-A12',
  username: 'tongzh',
  osId: 'ubuntu',
  osName: 'Ubuntu 22.04 LTS',
  timestamp: now,
  status: 'online',
  system: {
    cpuModel: 'AMD EPYC 9654 96-Core Processor',
    cpuUtilization: 1.8,
    currentUserCpuUtilization: 2.9,
    load1: 2.27,
    load5: 2.06,
    load15: 1.98,
    memoryUsedBytes: 32_547_074_048,
    memoryTotalBytes: 270_270_775_296,
    swapUsedBytes: 92_151_808,
    swapTotalBytes: 8_589_930_496,
  },
  gpus: [
    { index: 0, uuid: 'GPU-f689', name: 'NVIDIA A100-PCIE-40GB', utilization: 100, memoryUtilization: 81, memoryUsedMb: 37705, memoryTotalMb: 40960, temperatureCelsius: 67, powerWatts: 252.58 },
    { index: 1, uuid: 'GPU-4b25', name: 'NVIDIA A100-PCIE-40GB', utilization: 0, memoryUtilization: 0, memoryUsedMb: 11943, memoryTotalMb: 40960, temperatureCelsius: 35, powerWatts: 40.83 },
    { index: 2, uuid: 'GPU-86d3', name: 'NVIDIA A100-PCIE-40GB', utilization: 0, memoryUtilization: 0, memoryUsedMb: 14, memoryTotalMb: 40960, temperatureCelsius: 34, powerWatts: 34.92 },
  ],
  disks: [
    { mountPoint: '/', usedBytes: 428 * 1024 ** 3, totalBytes: 2 * 1024 ** 4, availableBytes: 1620 * 1024 ** 3, currentUserUsedBytes: 64 * 1024 ** 3 },
    { mountPoint: '/data', usedBytes: 3.4 * 1024 ** 4, totalBytes: 8 * 1024 ** 4, availableBytes: 4.6 * 1024 ** 4, currentUserUsedBytes: 620 * 1024 ** 3 },
  ],
  processes: [
    { gpuUuid: 'GPU-f689', gpuIndex: 0, pid: 2146705, parentPid: 1, username: 'zxy', command: 'VLLM::EngineCore', memoryUsedMb: 37682, smUtilization: 99, cpuPercent: 27, elapsed: '13:15:10', isCurrentUser: false, isGroupLeader: true },
    { gpuUuid: 'GPU-4b25', gpuIndex: 1, pid: 1542739, parentPid: 1, username: 'qjz', command: 'VLLM::EngineCore', memoryUsedMb: 11920, smUtilization: null, cpuPercent: 5, elapsed: '3-03:49:20', isCurrentUser: false, isGroupLeader: true },
  ],
  cpuProcesses: [
    { pid: 2146812, parentPid: 2146705, username: 'zxy', command: 'python vllm-worker.py', cpuPercent: 18.4, memoryPercent: 2.1, memoryUsedBytes: 5_675_417_600, elapsed: '13:14:58', isCurrentUser: false, isGroupLeader: false },
    { pid: 1542810, parentPid: 1542739, username: 'qjz', command: 'python tokenizer-worker.py', cpuPercent: 4.2, memoryPercent: 0.8, memoryUsedBytes: 2_162_166_784, elapsed: '3-03:48:59', isCurrentUser: false, isGroupLeader: false },
  ],
  processesSampled: true,
  nvidiaSmi: 'available',
}

let browserServers = [...demoServers]
let browserSettings = { ...defaultSettings }
let browserReservations: IdleReservation[] = []
const browserInteractionSummary: InteractionLogSummary = { sentBytes: 0, responseBytes: 0, storedBytes: 0, localStorageBytes: 36.3 * 1024 ** 2, failureCount: 0, servers: [] }

function rollingHistory(snapshot: Snapshot): HistoryPoint[] {
  const historyNow = Math.floor(Date.now() / 1000)
  return Array.from({ length: 60 }, (_, index) => {
    const phase = index / 6
    return {
      timestamp: historyNow - (59 - index) * 30,
      cpuUtilization: clampPercent(Math.max(2, snapshot.system.cpuUtilization + Math.sin(phase) * 8)),
      memoryUtilization: clampPercent((snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes) * 100),
      swapUtilization: clampPercent(snapshot.system.swapTotalBytes ? (snapshot.system.swapUsedBytes / snapshot.system.swapTotalBytes) * 100 : 0),
      gpuUtilizations: Object.fromEntries(snapshot.gpus.map((gpu, gpuIndex) => [gpu.uuid, clampPercent(gpu.utilization + Math.sin(phase + gpuIndex) * 4)])),
      gpuMemoryUtilizations: Object.fromEntries(snapshot.gpus.map((gpu) => [gpu.uuid, gpuMemoryPercent(gpu)])),
    }
  })
}

export const api = {
  isDesktop: isTauri,
  async listServers(): Promise<Server[]> {
    return isTauri ? invoke('list_servers') : browserServers
  },
  async saveServer(draft: ServerDraft): Promise<Server> {
    if (isTauri) return invoke('save_server', { draft })
    const server: Server = {
      ...draft,
      id: draft.id ?? crypto.randomUUID(),
      sortOrder: browserServers.find((item) => item.id === draft.id)?.sortOrder ?? browserServers.length,
      status: 'unknown',
      lastError: null,
      lastSeenAt: null,
    }
    browserServers = [...browserServers.filter((item) => item.id !== server.id), server]
    return server
  },
  async deleteServer(serverId: string, revokeSshAccess = false): Promise<RemoteCleanupResult> {
    if (isTauri) return invoke('delete_server', { serverId, revokeSshAccess })
    browserServers = browserServers.filter((server) => server.id !== serverId)
    return { remoteCleaned: true, cleanupPending: false, message: '服务器已删除' }
  },
  async retryRemoteCleanups(): Promise<RemoteCleanupSweepResult> {
    if (isTauri) return invoke('retry_remote_cleanups')
    return { cleanedNames: [], pendingNames: [], expiredNames: [] }
  },
  async reorderServers(serverIds: string[]): Promise<void> {
    if (isTauri) return invoke('reorder_servers', { serverIds })
    const order = new Map(serverIds.map((id, index) => [id, index]))
    browserServers = [...browserServers].sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)).map((server, index) => ({ ...server, sortOrder: index }))
  },
  async startTerminal(serverId: string, columns: number, rows: number, gpuIndex?: number): Promise<string> {
    if (!isTauri) throw new Error('终端仅在 RackTop 桌面 App 中可用')
    return invoke('start_terminal', { serverId, columns, rows, gpuIndex: gpuIndex ?? null })
  },
  async writeTerminal(sessionId: string, data: string): Promise<void> {
    if (isTauri) return invoke('write_terminal', { sessionId, data })
  },
  async resizeTerminal(sessionId: string, columns: number, rows: number): Promise<void> {
    if (isTauri) return invoke('resize_terminal', { sessionId, columns, rows })
  },
  async closeTerminal(sessionId: string): Promise<void> {
    if (isTauri) return invoke('close_terminal', { sessionId })
  },
  async updateTraySummary(waiting: number, current: number, pending: number): Promise<void> {
    if (isTauri) return invoke('update_tray_summary', { waiting, current, pending })
  },
  async collectServer(serverId: string, includeProcesses = true, includeDisks = true, recordHistory = true, allowCredentialPrompt = false): Promise<Snapshot> {
    if (isTauri) return invoke('collect_server', { serverId, includeProcesses, includeDisks, recordHistory, allowCredentialPrompt })
    const server = browserServers.find((item) => item.id === serverId)
    const remoteCommand = `RACKTOP_INCLUDE_PROCESSES=${includeProcesses ? 1 : 0} RACKTOP_INCLUDE_DISKS=${includeDisks ? 1 : 0}; export LANG=C LC_ALL=C; printf '__RACKTOP_USER__\\n'; id -un; printf '__RACKTOP_HOST__\\n'; hostname; head -n 1 /proc/stat; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo; nvidia-smi --query-gpu=index,name,uuid,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits; ps -eo user:64=,uid=,pid=,ppid=,pgid=,pcpu=,pmem=,rss=,etime=,args= --sort=-pcpu`
    const command = `ssh -o BatchMode=yes ${server?.username ?? 'user'}@${server?.host ?? 'host'} '${remoteCommand}'`
    const sentBytes = new TextEncoder().encode(command).length
    const startedAt = Date.now()
    let entry: InteractionServerSummary = browserInteractionSummary.servers.find((item) => item.serverId === serverId) ?? { serverId, serverName: server?.name ?? serverId, sentBytes: 0, responseBytes: 0, storedBytes: 0, lastStartedAt: startedAt, lastFinishedAt: null, lastCommand: command, status: 'running' }
    entry = { ...entry, serverName: server?.name ?? serverId, sentBytes: entry.sentBytes + sentBytes, lastStartedAt: startedAt, lastFinishedAt: null, lastCommand: command, status: 'running', error: null }
    browserInteractionSummary.sentBytes += sentBytes
    browserInteractionSummary.servers = [...browserInteractionSummary.servers.filter((item) => item.serverId !== serverId), entry].sort((left, right) => left.serverName.localeCompare(right.serverName, 'zh-CN'))
    await new Promise((resolve) => setTimeout(resolve, 450))
    const source = serverId === 'demo-132' ? a100Snapshot : demoSnapshot
    const snapshot = { ...source, serverId, timestamp: Math.floor(Date.now() / 1000), processesSampled: includeProcesses, disks: includeDisks ? source.disks : [] }
    const responseBytes = new TextEncoder().encode(JSON.stringify(snapshot)).length
    const storedBytes = recordHistory ? responseBytes : 0
    browserInteractionSummary.responseBytes += responseBytes
    browserInteractionSummary.storedBytes += storedBytes
    browserInteractionSummary.servers = browserInteractionSummary.servers.map((item) => item.serverId === serverId ? { ...item, lastFinishedAt: Date.now(), responseBytes: item.responseBytes + responseBytes, storedBytes: item.storedBytes + storedBytes, status: 'success' } : item)
    return snapshot
  },
  async getInteractionLogSummary(): Promise<InteractionLogSummary> {
    return isTauri ? invoke('get_interaction_log_summary') : { ...browserInteractionSummary, servers: browserInteractionSummary.servers.map((item) => ({ ...item })) }
  },
  async getHistory(serverId: string, fromTimestamp: number): Promise<HistoryPoint[]> {
    if (isTauri) return invoke('get_history', { serverId, fromTimestamp })
    const source = serverId === 'demo-132' ? a100Snapshot : demoSnapshot
    return rollingHistory({ ...source, serverId })
  },
  async getHistoryHeatmap(serverId: string, fromTimestamp: number, timezoneOffsetSeconds: number, gpuUuids: string[]): Promise<HistoryHeatmapPoint[]> {
    if (isTauri) return invoke('get_history_heatmap', { serverId, fromTimestamp, timezoneOffsetSeconds, gpuUuids })
    const source = serverId === 'demo-132' ? a100Snapshot : demoSnapshot
    const firstBucket = Math.floor((fromTimestamp + timezoneOffsetSeconds) / 10_800) * 10_800 - timezoneOffsetSeconds
    const lastBucket = Math.floor((Math.floor(Date.now() / 1000) + timezoneOffsetSeconds) / 10_800) * 10_800 - timezoneOffsetSeconds
    return Array.from({ length: Math.max(0, Math.floor((lastBucket - firstBucket) / 10_800) + 1) }, (_, index) => {
      const timestamp = firstBucket + index * 10_800
      const phase = index / 3
      return {
        timestamp,
        sampleCount: 180,
        cpuUtilization: clampPercent(source.system.cpuUtilization + Math.sin(phase) * 14),
        memoryUtilization: clampPercent(source.system.memoryTotalBytes ? source.system.memoryUsedBytes / source.system.memoryTotalBytes * 100 + Math.sin(phase / 2) * 3 : 0),
        gpuUtilizations: Object.fromEntries(gpuUuids.map((uuid, gpuIndex) => [uuid, clampPercent((source.gpus.find((gpu) => gpu.uuid === uuid)?.utilization ?? 0) + Math.sin(phase + gpuIndex) * 24)])),
        gpuMemoryUtilizations: Object.fromEntries(gpuUuids.map((uuid, gpuIndex) => [uuid, clampPercent(gpuMemoryPercent(source.gpus.find((gpu) => gpu.uuid === uuid) ?? source.gpus[gpuIndex]) + Math.sin(phase / 3 + gpuIndex) * 5)])),
      }
    })
  },
  async getUsageDistribution(serverId: string, fromTimestamp: number, requestedDays: number): Promise<UsageDistribution> {
    if (isTauri) return invoke('get_usage_distribution', { serverId, fromTimestamp, requestedDays })
    return { users: [], coveredDays: 0, requestedDays, coverageGpuSeconds: 0 }
  },
  async configureRemoteHistory(serverId: string): Promise<void> {
    if (isTauri) return invoke('configure_remote_history', { serverId })
  },
  async syncRemoteHistory(serverId: string): Promise<RemoteHistorySyncResult> {
    if (isTauri) return invoke('sync_remote_history', { serverId })
    return { importedCount: 0, latestTimestamp: null }
  },
  async listIdleReservations(): Promise<IdleReservation[]> {
    return isTauri ? invoke('list_idle_reservations') : browserReservations
  },
  async saveIdleReservation(reservation: IdleReservation): Promise<IdleReservation> {
    if (isTauri) return invoke('save_idle_reservation', { reservation })
    browserReservations = [reservation, ...browserReservations.filter((item) => item.id !== reservation.id)]
    return reservation
  },
  async deleteIdleReservation(reservationId: string): Promise<void> {
    if (isTauri) return invoke('delete_idle_reservation', { reservationId })
    browserReservations = browserReservations.filter((item) => item.id !== reservationId)
  },
  async importSshConfig(path?: string): Promise<ServerDraft[]> {
    if (isTauri) return invoke('import_ssh_config', { path: path || null })
    return []
  },
  async getSettings(): Promise<AppSettings> {
    return isTauri ? invoke('get_settings') : browserSettings
  },
  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (isTauri) return invoke('save_settings', { settings })
    browserSettings = settings
    return settings
  },
  async retryNvidia(serverId: string): Promise<Snapshot> {
    return this.collectServer(serverId, true, true, true, true)
  },
  async scanHostKey(serverId: string): Promise<HostKeyInfo> {
    if (isTauri) return invoke('scan_host_key', { serverId })
    return { serverId, host: 'demo.local', algorithm: 'ssh-ed25519', fingerprint: 'SHA256:demoFingerprint', keyLine: 'demo.local ssh-ed25519 AAAA', changed: false }
  },
  async trustHostKey(info: HostKeyInfo): Promise<void> {
    if (isTauri) return invoke('trust_host_key', { info })
  },
  async installNvidiaDriver(serverId: string): Promise<string> {
    if (isTauri) return invoke('install_nvidia_driver', { serverId, confirmed: true })
    return `已在演示服务器 ${serverId} 上模拟执行安装。`
  },
  async terminateProcess(serverId: string, pid: number): Promise<string> {
    if (isTauri) return invoke('terminate_process', { serverId, pid, confirmed: true })
    return `已在演示服务器 ${serverId} 上模拟结束 PID ${pid}。`
  },
  async notify(title: string, body: string, extra?: Record<string, unknown>): Promise<void> {
    if (!isTauri) return
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (granted) sendNotification({ title, body, extra, autoCancel: true })
  },
  async onNotificationAction(callback: (extra: Record<string, unknown>) => void): Promise<() => void> {
    if (!isTauri) return () => {}
    const listener = await onAction((notification) => callback(notification.extra ?? {}))
    return () => listener.unregister()
  },
}
