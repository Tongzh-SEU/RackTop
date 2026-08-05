export type ServerStatus = 'online' | 'offline' | 'connecting' | 'warning' | 'unknown'
export type AuthMethod = 'sshAgent' | 'privateKey' | 'password' | 'sshConfig'

export interface Server {
  id: string
  name: string
  location?: string | null
  host: string
  port: number
  username: string
  sshAlias?: string | null
  identityFile?: string | null
  proxyJump?: string | null
  tags: string[]
  samplingIntervalSeconds: number
  historyRetentionDays: number
  remoteHistoryEnabled: boolean
  remoteHistoryLastSyncAt?: number | null
  sortOrder?: number
  authMethod: AuthMethod
  status: ServerStatus
  lastError?: string | null
  lastSeenAt?: number | null
}

export interface GpuMetric {
  index: number
  uuid: string
  name: string
  utilization: number
  memoryUtilization: number
  memoryUsedMb: number
  memoryTotalMb: number
  temperatureCelsius: number
  powerWatts: number
}

export interface ProcessMetric {
  gpuUuid: string
  gpuIndex: number
  pid: number
  parentPid: number
  username: string
  command: string
  memoryUsedMb: number
  smUtilization: number | null
  cpuPercent: number
  elapsed: string
  isCurrentUser: boolean
  isGroupLeader: boolean
}

export interface CpuProcessMetric {
  pid: number
  parentPid: number
  username: string
  command: string
  cpuPercent: number
  memoryPercent: number
  memoryUsedBytes: number
  elapsed: string
  isCurrentUser: boolean
  isGroupLeader: boolean
}

export interface SystemMetric {
  cpuModel: string
  cpuUtilization: number
  currentUserCpuUtilization: number
  load1: number
  load5: number
  load15: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  swapUsedBytes: number
  swapTotalBytes: number
}

export interface Snapshot {
  serverId: string
  hostname: string
  username: string
  osId: string
  osName: string
  timestamp: number
  status: ServerStatus
  system: SystemMetric
  gpus: GpuMetric[]
  disks?: DiskMetric[]
  processes: ProcessMetric[]
  cpuProcesses: CpuProcessMetric[]
  processesSampled: boolean
  nvidiaSmi: 'available' | 'missing' | 'permissionDenied' | 'failed'
  nvidiaMessage?: string | null
}

export interface DiskMetric {
  mountPoint: string
  usedBytes: number
  totalBytes: number
  availableBytes: number
  currentUserUsedBytes?: number
}

export interface HistoryPoint {
  timestamp: number
  cpuUtilization: number
  memoryUtilization: number
  swapUtilization: number
  gpuUtilizations: Record<string, number>
  gpuMemoryUtilizations: Record<string, number>
}

export interface HistoryHeatmapPoint {
  timestamp: number
  sampleCount: number
  cpuUtilization: number
  memoryUtilization: number
  gpuUtilizations: Record<string, number>
  gpuMemoryUtilizations: Record<string, number>
}

export interface RemoteHistorySyncResult {
  importedCount: number
  latestTimestamp?: number | null
}

export interface UsageUserAggregate {
  username: string
  activeSeconds: number
  memoryMbSeconds: number
}

export interface UsageDistribution {
  users: UsageUserAggregate[]
  coveredDays: number
  requestedDays: number
  coverageGpuSeconds: number
}

export interface HostKeyInfo {
  serverId: string
  host: string
  algorithm: string
  fingerprint: string
  keyLine: string
  changed: boolean
}

export interface AppSettings {
  defaultSamplingIntervalSeconds: number
  backgroundSamplingIntervalSeconds: number
  processIntervalSeconds: number
  realtimeWindowMinutes: number
  historyEnabled: boolean
  historyRetentionDays: number
  idleGpuThreshold: number
  idleMemoryThresholdMb: number
  idleDurationMinutes: number
  temperatureThresholdCelsius: number
  currentUserAccent: string
  theme: 'system' | 'light' | 'dark'
  reduceMotion: boolean
  showAddServerGuide: boolean
}

export interface IdleReservationFilters {
  gpuMemoryGb: number
  cpuMemoryGb: number
  otherUserProcess: 'all' | 'without'
  gpuModel: string
  cpuModel: string
  duration: number
  tag: string
  targetServerId?: string
  targetGpuUuid?: string
}

export type IdleReservationStatus = 'active' | 'paused' | 'completed' | 'expired'

export interface IdleReservation {
  id: string
  name: string
  filters: IdleReservationFilters
  createdAt: number
  expiresAt: number | null
  notifyMode: 'once' | 'continuous'
  status: IdleReservationStatus
  matchedGpuKeys: string[]
  currentAvailableGpuKeys?: string[]
  pendingConfirmationGpuKeys?: string[]
}

export type DetailTab = 'overview' | 'processes' | 'terminal' | 'gpu' | 'cpu' | 'history' | 'connection'

export interface ServerDraft {
  id?: string
  name: string
  location?: string
  host: string
  port: number
  username: string
  sshAlias?: string
  identityFile?: string
  proxyJump?: string
  tags: string[]
  samplingIntervalSeconds: number
  historyRetentionDays: number
  remoteHistoryEnabled: boolean
  authMethod: AuthMethod
  password?: string
  savePassword?: boolean
}

export interface RemoteCleanupResult {
  remoteCleaned: boolean
  cleanupPending: boolean
  message: string
}

export interface RemoteCleanupSweepResult {
  cleanedNames: string[]
  pendingNames: string[]
  expiredNames: string[]
}
