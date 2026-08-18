import { invoke } from '@tauri-apps/api/core'
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { AppSettings, HistoryHeatmapPoint, HistoryPoint, HostKeyInfo, IdleReservation, InteractionLogSummary, InteractionServerSummary, ManagedRunLaunchResult, ManagedRunRemoteStatus, Project, ProjectDraft, ProjectPathCheck, ProjectSyncProgress, ProjectSyncResult, RemoteCleanupResult, RemoteCleanupSweepResult, RemoteHistorySyncResult, Server, ServerDraft, Snapshot, UsageDistribution } from '../types/models'
import { clampPercent, gpuMemoryPercent, hasOtherUserGpuWorkload } from '../utils/gpu'
import { RACKTOP_MANAGED_IDENTITY_PATH } from '../utils/sshSetup'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

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
  {
    id: 'demo-4090', name: '4*4090', location: '计算中心 2 楼 · R5 机架', host: '10.201.37.240', port: 22, username: 'tongzh', tags: ['lab', '4090'], samplingIntervalSeconds: 2, historyRetentionDays: 30, remoteHistoryEnabled: false, sortOrder: 2, authMethod: 'sshAgent', status: 'online', lastSeenAt: now,
  },
  {
    id: 'demo-h100', name: '8*H100', location: '计算中心 1 楼 · H2 机架', host: '10.201.37.250', port: 22, username: 'tongzh', tags: ['lab', 'H100'], samplingIntervalSeconds: 2, historyRetentionDays: 30, remoteHistoryEnabled: false, sortOrder: 3, authMethod: 'sshAgent', status: 'online', lastSeenAt: now,
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
  menuBarMode: 'compact',
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
    cpuPhysicalCores: 16,
    cpuLogicalCores: 32,
    cpuFrequencyMhz: 2800,
    cpuMaxFrequencyMhz: 3500,
    cpuUserPercent: 8.7,
    cpuSystemPercent: 3.1,
    cpuIoWaitPercent: 1.4,
    cpuStealPercent: 0,
    cpuTemperatureCelsius: 52,
    memoryAvailableBytes: 116_266_106_880,
    memoryCacheBytes: 18_790_481_920,
  },
  gpus: [
    { index: 0, uuid: 'GPU-9e1c', name: 'NVIDIA GeForce RTX 4090 D', utilization: 78, memoryUtilization: 64, memoryUsedMb: 18435, memoryTotalMb: 24564, temperatureCelsius: 68, powerWatts: 318.4, powerLimitWatts: 425, smClockMhz: 2520, memoryClockMhz: 10501, performanceState: 'P2', fanSpeedPercent: 62, throttleReason: '正常' },
    { index: 1, uuid: 'GPU-d3f2', name: 'NVIDIA GeForce RTX 4090 D', utilization: 0, memoryUtilization: 0, memoryUsedMb: 15, memoryTotalMb: 24564, temperatureCelsius: 45, powerWatts: 18.81, powerLimitWatts: 425, smClockMhz: 210, memoryClockMhz: 405, performanceState: 'P8', fanSpeedPercent: 28, throttleReason: '空闲' },
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
    cpuPhysicalCores: 96,
    cpuLogicalCores: 192,
    cpuFrequencyMhz: 2400,
    cpuMaxFrequencyMhz: 3700,
    cpuUserPercent: 0.8,
    cpuSystemPercent: 0.5,
    cpuIoWaitPercent: 0.3,
    cpuStealPercent: 0,
    cpuTemperatureCelsius: 47,
    memoryAvailableBytes: 231_928_233_984,
    memoryCacheBytes: 74_518_691_840,
  },
  gpus: [
    { index: 0, uuid: 'GPU-f689', name: 'NVIDIA A100-PCIE-40GB', utilization: 100, memoryUtilization: 81, memoryUsedMb: 37705, memoryTotalMb: 40960, temperatureCelsius: 67, powerWatts: 252.58, powerLimitWatts: 300, smClockMhz: 1410, memoryClockMhz: 1215, performanceState: 'P0', throttleReason: '正常', eccErrors: 0 },
    { index: 1, uuid: 'GPU-4b25', name: 'NVIDIA A100-PCIE-40GB', utilization: 0, memoryUtilization: 0, memoryUsedMb: 11943, memoryTotalMb: 40960, temperatureCelsius: 35, powerWatts: 40.83, powerLimitWatts: 300, smClockMhz: 765, memoryClockMhz: 1215, performanceState: 'P2', throttleReason: '应用时钟', eccErrors: 0 },
    { index: 2, uuid: 'GPU-86d3', name: 'NVIDIA A100-PCIE-40GB', utilization: 0, memoryUtilization: 0, memoryUsedMb: 14, memoryTotalMb: 40960, temperatureCelsius: 34, powerWatts: 34.92, powerLimitWatts: 300, smClockMhz: 210, memoryClockMhz: 1215, performanceState: 'P8', throttleReason: '空闲', eccErrors: 0 },
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
let browserProjects: Project[] = [
  {
    id: 'demo-project-waterflower', name: '水仙花数', kind: 'project', sourceServerId: 'demo-233', sourcePath: '~/projects/narcissistic-number',
    sourceExists: true, sourceIsDirectory: true, sourceSizeBytes: 48 * 1024, sourceFileCount: 5, sourceModifiedAt: now - 420,
    datasetIds: ['demo-dataset-apps'],
    targets: [
      { serverId: 'demo-132', path: '~/projects/narcissistic-number', status: 'found', exists: true, isDirectory: true, sizeBytes: 42 * 1024, fileCount: 4, modifiedAt: now - 3_600, lastCheckedAt: now - 30, lastSyncedAt: now - 86_400, syncedSourceSizeBytes: 40 * 1024, syncedSourceFileCount: 4, syncedSourceModifiedAt: now - 86_800, syncedTargetSizeBytes: 40 * 1024, syncedTargetFileCount: 4, syncedTargetModifiedAt: now - 86_800 },
      { serverId: 'demo-4090', path: '~/projects/narcissistic-number', status: 'synced', exists: true, isDirectory: true, sizeBytes: 48 * 1024, fileCount: 5, modifiedAt: now - 420, lastCheckedAt: now - 25, lastSyncedAt: now - 360, syncedSourceSizeBytes: 48 * 1024, syncedSourceFileCount: 5, syncedSourceModifiedAt: now - 420, syncedTargetSizeBytes: 48 * 1024, syncedTargetFileCount: 5, syncedTargetModifiedAt: now - 420 },
      { serverId: 'demo-h100', path: '~/workspace/narcissistic-number', status: 'missing', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, modifiedAt: null, lastCheckedAt: now - 20 },
    ],
    createdAt: now - 172_800, updatedAt: now - 30, lastSyncAt: now - 86_400, status: 'unknown', lastError: null,
  },
  {
    id: 'demo-project-training', name: 'Llama 微调', kind: 'project', sourceServerId: 'demo-132', sourcePath: '~/projects/llama-finetune',
    sourceExists: true, sourceIsDirectory: true, sourceSizeBytes: 286 * 1024 ** 2, sourceFileCount: 318, sourceModifiedAt: now - 120,
    datasetIds: ['demo-dataset-apps'],
    targets: [
      { serverId: 'demo-233', path: '~/projects/llama-finetune', status: 'conflict', exists: true, isDirectory: true, sizeBytes: 282 * 1024 ** 2, fileCount: 320, modifiedAt: now - 60, lastCheckedAt: now - 20, lastSyncedAt: now - 7_200, syncedSourceSizeBytes: 282 * 1024 ** 2, syncedSourceFileCount: 318, syncedSourceModifiedAt: now - 7_300, syncedTargetSizeBytes: 282 * 1024 ** 2, syncedTargetFileCount: 318, syncedTargetModifiedAt: now - 7_300, error: '目标内容已在上次同步后修改' },
    ],
    createdAt: now - 604_800, updatedAt: now - 20, lastSyncAt: now - 7_200, status: 'error', lastError: '目标内容已修改',
  },
  {
    id: 'demo-dataset-apps', name: 'APPS_hf', kind: 'dataset', sourceServerId: 'demo-233', sourcePath: '~/datasets/APPS_hf',
    sourceExists: true, sourceIsDirectory: true, sourceSizeBytes: 8.6 * 1024 ** 3, sourceFileCount: 12_480, sourceModifiedAt: now - 3_600,
    datasetIds: [],
    targets: [
      { serverId: 'demo-132', path: '~/datasets/APPS_hf', status: 'synced', exists: true, isDirectory: true, sizeBytes: 8.6 * 1024 ** 3, fileCount: 12_480, modifiedAt: now - 3_600, lastCheckedAt: now - 20, lastSyncedAt: now - 3_000, syncedSourceSizeBytes: 8.6 * 1024 ** 3, syncedSourceFileCount: 12_480, syncedSourceModifiedAt: now - 3_600, syncedTargetSizeBytes: 8.6 * 1024 ** 3, syncedTargetFileCount: 12_480, syncedTargetModifiedAt: now - 3_600 },
      { serverId: 'demo-4090', path: '~/datasets/APPS_hf', status: 'found', exists: true, isDirectory: true, sizeBytes: 8.4 * 1024 ** 3, fileCount: 12_102, modifiedAt: now - 86_400, lastCheckedAt: now - 20 },
      { serverId: 'demo-h100', path: '~/datasets/APPS_hf', status: 'missing', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, modifiedAt: null, lastCheckedAt: now - 20 },
    ],
    createdAt: now - 1_209_600, updatedAt: now - 20, lastSyncAt: now - 3_000, status: 'synced', lastError: null,
  },
  {
    id: 'demo-model-llama', name: 'Llama-3-8B', kind: 'model', sourceServerId: 'demo-132', sourcePath: '~/models/Llama-3-8B',
    sourceExists: true, sourceIsDirectory: true, sourceSizeBytes: 15.2 * 1024 ** 3, sourceFileCount: 18, sourceModifiedAt: now - 1_800,
    datasetIds: [],
    targets: [
      { serverId: 'demo-233', path: '~/models/Llama-3-8B', status: 'synced', exists: true, isDirectory: true, sizeBytes: 15.2 * 1024 ** 3, fileCount: 18, modifiedAt: now - 1_800, lastCheckedAt: now - 40, lastSyncedAt: now - 1_200, syncedSourceSizeBytes: 15.2 * 1024 ** 3, syncedSourceFileCount: 18, syncedSourceModifiedAt: now - 1_800, syncedTargetSizeBytes: 15.2 * 1024 ** 3, syncedTargetFileCount: 18, syncedTargetModifiedAt: now - 1_800 },
      { serverId: 'demo-h100', path: '~/models/Llama-3-8B', status: 'missing', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, modifiedAt: null, lastCheckedAt: now - 35 },
    ],
    createdAt: now - 86_400, updatedAt: now - 35, lastSyncAt: now - 1_200, status: 'unknown', lastError: null,
  },
]
const browserProjectSyncProgress: ProjectSyncProgress[] = [{ projectId: 'demo-project-waterflower', targetServerId: 'demo-h100', transferredBytes: 31 * 1024, resumedBytes: 12 * 1024, totalBytes: 48 * 1024, startedAt: now - 12, state: 'transferring' }]
const historyRequests = new Map<string, { expiresAt: number; request: Promise<HistoryPoint[]> }>()
const browserInteractionSummary: InteractionLogSummary = { sentBytes: 0, responseBytes: 0, storedBytes: 0, localStorageBytes: 36.3 * 1024 ** 2, failureCount: 0, servers: [] }

function rollingHistory(snapshot: Snapshot): HistoryPoint[] {
  const historyNow = Math.floor(Date.now() / 1000)
  return Array.from({ length: 121 }, (_, index) => {
    const phase = index / 6
    return {
      timestamp: historyNow - (120 - index) * 30,
      cpuUtilization: clampPercent(Math.max(2, snapshot.system.cpuUtilization + Math.sin(phase) * 8)),
      memoryUtilization: clampPercent((snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes) * 100),
      swapUtilization: clampPercent(snapshot.system.swapTotalBytes ? (snapshot.system.swapUsedBytes / snapshot.system.swapTotalBytes) * 100 : 0),
      gpuUtilizations: Object.fromEntries(snapshot.gpus.map((gpu, gpuIndex) => [gpu.uuid, clampPercent(gpu.utilization + Math.sin(phase + gpuIndex) * 4)])),
      gpuMemoryUtilizations: Object.fromEntries(snapshot.gpus.map((gpu) => [gpu.uuid, gpuMemoryPercent(gpu)])),
      gpuOtherUserOccupancies: Object.fromEntries(snapshot.gpus.map((gpu) => [gpu.uuid, hasOtherUserGpuWorkload(gpu, snapshot.processes)])),
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
    browserProjects = browserProjects.map((project) => {
      const sourceRemoved = project.sourceServerId === serverId
      const targets = project.targets.filter((target) => target.serverId !== serverId)
      const targetRemoved = targets.length !== project.targets.length
      if (!sourceRemoved && !targetRemoved) return project
      return {
        ...project,
        sourceExists: sourceRemoved ? false : project.sourceExists,
        status: sourceRemoved ? 'error' : 'unknown',
        lastError: sourceRemoved ? '主服务器已移除' : null,
        targets,
      }
    })
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
  async updateTraySummary(mode: AppSettings['menuBarMode'], reservationPending: number, processWarnings: number): Promise<void> {
    if (isTauri) return invoke('update_tray_summary', { mode, reservationPending, processWarnings })
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
  async getHistory(serverId: string, fromTimestamp: number, bucketSeconds?: number): Promise<HistoryPoint[]> {
    const cacheKey = `${serverId}:${Math.floor(fromTimestamp / 30)}:${bucketSeconds ?? 0}`
    const cached = historyRequests.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.request
    const request = (async () => {
      if (isTauri) return invoke<HistoryPoint[]>('get_history', { serverId, fromTimestamp, bucketSeconds: bucketSeconds ?? null })
      const source = serverId === 'demo-132' ? a100Snapshot : demoSnapshot
      const points = rollingHistory({ ...source, serverId })
      if (!bucketSeconds) return points
      return Object.values(points.reduce<Record<number, HistoryPoint>>((buckets, point) => {
        const timestamp = Math.floor(point.timestamp / bucketSeconds) * bucketSeconds
        const current = buckets[timestamp]
        if (!current) return { ...buckets, [timestamp]: { ...point, timestamp, isCompacted: true } }
        const next = { ...current, cpuUtilization: (current.cpuUtilization + point.cpuUtilization) / 2, memoryUtilization: (current.memoryUtilization + point.memoryUtilization) / 2, swapUtilization: (current.swapUtilization + point.swapUtilization) / 2 }
        return { ...buckets, [timestamp]: next }
      }, {})).sort((left, right) => left.timestamp - right.timestamp)
    })()
    historyRequests.set(cacheKey, { expiresAt: Date.now() + 5_000, request })
    request.catch(() => historyRequests.delete(cacheKey))
    return request
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
  async listProjects(): Promise<Project[]> {
    return isTauri ? invoke('list_projects') : browserProjects
  },
  async saveProject(draft: ProjectDraft): Promise<Project> {
    if (isTauri) return invoke('save_project', { draft })
    const previous = browserProjects.find((item) => item.id === draft.id)
    const timestamp = Math.floor(Date.now() / 1000)
    const project: Project = {
      id: draft.id ?? crypto.randomUUID(), name: draft.name, kind: draft.kind,
      sourceServerId: draft.sourceServerId, sourcePath: draft.sourcePath,
      sourceExists: previous?.sourceExists ?? false, sourceIsDirectory: previous?.sourceIsDirectory ?? true,
      sourceSizeBytes: previous?.sourceSizeBytes ?? 0, sourceFileCount: previous?.sourceFileCount ?? 0, sourceModifiedAt: previous?.sourceModifiedAt ?? null,
      datasetIds: draft.kind === 'project' ? draft.datasetIds : [],
      targets: draft.targets.map((target) => ({ serverId: target.serverId, path: target.path, status: 'unknown', exists: false, isDirectory: true, sizeBytes: 0, fileCount: 0, modifiedAt: null })),
      createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, lastSyncAt: previous?.lastSyncAt ?? null,
      status: 'unknown', lastError: null,
    }
    browserProjects = [project, ...browserProjects.filter((item) => item.id !== project.id)]
    return project
  },
  async deleteProject(projectId: string): Promise<void> {
    if (isTauri) return invoke('delete_project', { projectId })
    browserProjects = browserProjects.filter((item) => item.id !== projectId)
  },
  async probeProjectPaths(draft: ProjectDraft): Promise<ProjectPathCheck[]> {
    if (isTauri) return invoke('probe_project_paths', { draft })
    return [
      { serverId: draft.sourceServerId, requestedPath: draft.sourcePath, suggestedPath: draft.sourcePath, exists: true, isDirectory: true, sizeBytes: 8.6 * 1024 ** 3, fileCount: 1240, modifiedAt: now - 420, matches: [] },
      ...draft.targets.map((target, index) => ({ serverId: target.serverId, requestedPath: target.path, suggestedPath: target.path, exists: index === 0, isDirectory: true, sizeBytes: index === 0 ? 8.4 * 1024 ** 3 : 0, fileCount: index === 0 ? 1214 : 0, modifiedAt: index === 0 ? now - 3_600 : null, matches: [] })),
    ]
  },
  async suggestProjectPaths(serverId: string, query: string): Promise<string[]> {
    if (isTauri) return invoke('suggest_project_paths', { serverId, query })
    const directoryNames = serverId === 'demo-132'
      ? ['datasets', 'llama-finetune', 'models', 'projects', 'shared']
      : ['checkpoints', 'datasets', 'llama-finetune', 'projects', 'workspace']
    const lastSlash = query.lastIndexOf('/')
    const parent = lastSlash >= 0 ? query.slice(0, lastSlash + 1) : '~/'
    const prefix = lastSlash >= 0 ? query.slice(lastSlash + 1).toLowerCase() : query.toLowerCase()
    return directoryNames.filter((name) => name.toLowerCase().startsWith(prefix)).map((name) => `${parent}${name}/`).slice(0, 12)
  },
  async inspectProject(projectId: string): Promise<Project> {
    if (isTauri) return invoke('inspect_project', { projectId })
    const project = browserProjects.find((item) => item.id === projectId)
    if (!project) throw new Error('项目不存在')
    return project
  },
  async inspectProjectSource(projectId: string): Promise<Project> {
    if (isTauri) return invoke('inspect_project_source', { projectId })
    const project = browserProjects.find((item) => item.id === projectId)
    if (!project) throw new Error('项目不存在')
    return project
  },
  async syncProject(projectId: string, targetServerId: string, force = false): Promise<ProjectSyncResult> {
    if (isTauri) return invoke('sync_project', { projectId, targetServerId, force })
    await new Promise((resolve) => window.setTimeout(resolve, 600))
    const timestamp = Math.floor(Date.now() / 1000)
    browserProjects = browserProjects.map((project) => project.id === projectId ? { ...project, status: 'synced', lastSyncAt: timestamp, targets: project.targets.map((target) => target.serverId === targetServerId ? { ...target, status: 'synced', exists: true, lastSyncedAt: timestamp, syncedSourceSizeBytes: project.sourceSizeBytes, syncedSourceFileCount: project.sourceFileCount, syncedSourceModifiedAt: project.sourceModifiedAt } : target) } : project)
    return { projectId, targetServerId, transferredBytes: 8.6 * 1024 ** 3, message: '同步完成' }
  },
  async listProjectSyncProgress(): Promise<ProjectSyncProgress[]> {
    return isTauri ? invoke('list_project_sync_progress') : browserProjectSyncProgress
  },
  async cancelProjectSync(projectId: string, targetServerId: string): Promise<void> {
    if (isTauri) return invoke('cancel_project_sync', { projectId, targetServerId })
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
  async launchManagedRun(serverId: string, runId: string, workingDirectory: string, command: string, gpuIndices: number[], projectLogPath: string | null = null): Promise<ManagedRunLaunchResult> {
    if (isTauri) return invoke('launch_managed_run', { serverId, runId, workingDirectory, command, gpuIndices, projectLogPath })
    await new Promise((resolve) => window.setTimeout(resolve, 500))
    return { pid: 60_000 + Math.floor(Math.random() * 9_000), logPath: `~/.racktop/runs/${runId}/output.log` }
  },
  async readManagedRunLog(serverId: string, runId: string, lines = 400): Promise<string> {
    if (isTauri) return invoke('read_managed_run_log', { serverId, runId, lines })
    return `[RackTop 演示日志]\nserver=${serverId}\nrun=${runId}\nstep 1840 · loss 0.8421\nstep 1841 · loss 0.8376`
  },
  async getManagedRunStatus(serverId: string, runId: string, pid: number): Promise<ManagedRunRemoteStatus> {
    if (isTauri) return invoke('get_managed_run_status', { serverId, runId, pid })
    return { status: 'running', exitCode: null }
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
