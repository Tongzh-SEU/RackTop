import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { AppSettings, HistoryHeatmapPoint, HistoryPoint, HostKeyInfo, IdleReservation, RemoteHistorySyncResult, Server, ServerDraft, Snapshot } from '../types/models'
import { clampPercent, gpuMemoryPercent } from '../utils/gpu'

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
    authMethod: 'sshAgent',
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
    authMethod: 'sshAgent',
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
  historyRetentionDays: 30,
  idleGpuThreshold: 10,
  idleMemoryThresholdMb: 40960,
  idleDurationMinutes: 10,
  temperatureThresholdCelsius: 85,
  currentUserAccent: '#0a84ff',
  theme: 'system',
  reduceMotion: false,
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
  processes: [],
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
      status: 'unknown',
      lastError: null,
      lastSeenAt: null,
    }
    browserServers = [...browserServers.filter((item) => item.id !== server.id), server]
    return server
  },
  async deleteServer(serverId: string): Promise<void> {
    if (isTauri) return invoke('delete_server', { serverId })
    browserServers = browserServers.filter((server) => server.id !== serverId)
  },
  async collectServer(serverId: string, includeProcesses = true, recordHistory = true): Promise<Snapshot> {
    if (isTauri) return invoke('collect_server', { serverId, includeProcesses, recordHistory })
    await new Promise((resolve) => setTimeout(resolve, 450))
    const source = serverId === 'demo-132' ? a100Snapshot : demoSnapshot
    return { ...source, serverId, timestamp: Math.floor(Date.now() / 1000), processesSampled: includeProcesses }
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
    return this.collectServer(serverId, true)
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
