import type { HistoryPoint, IdleReservationFilters, Server, Snapshot } from '../types/models'
import { clampPercent, gpuMemoryPercent, hasOtherUserGpuWorkload } from './gpu'

export type IdleFilters = IdleReservationFilters

export const IDLE_FILTERS_STORAGE_KEY = 'racktop.idleFilters.v1'
export const DEFAULT_IDLE_FILTERS: IdleFilters = {
  gpuMemoryGb: 0,
  cpuMemoryGb: 0,
  otherUserProcess: 'without',
  gpuModel: 'all',
  cpuModel: 'all',
  duration: 0,
  tag: 'all',
}

function nonNegativeNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === 'string' && value ? value : fallback
}

export function normalizeIdleFilters(value: unknown): IdleFilters {
  const candidate = value && typeof value === 'object' ? value as Partial<IdleFilters> : {}
  const duration = nonNegativeNumber(candidate.duration, DEFAULT_IDLE_FILTERS.duration)
  return {
    gpuMemoryGb: nonNegativeNumber(candidate.gpuMemoryGb, DEFAULT_IDLE_FILTERS.gpuMemoryGb),
    cpuMemoryGb: nonNegativeNumber(candidate.cpuMemoryGb, DEFAULT_IDLE_FILTERS.cpuMemoryGb),
    otherUserProcess: candidate.otherUserProcess === 'all' ? 'all' : 'without',
    gpuModel: stringValue(candidate.gpuModel, DEFAULT_IDLE_FILTERS.gpuModel),
    cpuModel: stringValue(candidate.cpuModel, DEFAULT_IDLE_FILTERS.cpuModel),
    duration: [0, 5, 10, 30, 60].includes(duration) ? duration : DEFAULT_IDLE_FILTERS.duration,
    tag: stringValue(candidate.tag, DEFAULT_IDLE_FILTERS.tag),
  }
}

export function parseIdleFilters(serialized: string | null): IdleFilters {
  if (!serialized) return { ...DEFAULT_IDLE_FILTERS }
  try { return normalizeIdleFilters(JSON.parse(serialized)) } catch { return { ...DEFAULT_IDLE_FILTERS } }
}

export function loadIdleFilters(): IdleFilters {
  return typeof localStorage === 'undefined' ? { ...DEFAULT_IDLE_FILTERS } : parseIdleFilters(localStorage.getItem(IDLE_FILTERS_STORAGE_KEY))
}

export function saveIdleFilters(filters: IdleFilters) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(IDLE_FILTERS_STORAGE_KEY, JSON.stringify(normalizeIdleFilters(filters)))
}

export type IdleGpuItem = {
  server: Server
  gpu: Snapshot['gpus'][number]
  available: boolean
}

export function displayedFreeMemoryGb(memoryMb: number): number {
  const safeMemoryMb = Number.isFinite(memoryMb) ? Math.max(0, memoryMb) : 0
  return Math.round(safeMemoryMb / 1024 * 10) / 10
}

export function rankIdleGpuItems(servers: Server[], snapshots: Record<string, Snapshot>, history: Record<string, HistoryPoint[]>, filters: IdleFilters): IdleGpuItem[] {
  return servers.flatMap((server) => (snapshots[server.id]?.gpus ?? []).map((gpu) => ({ server, gpu }))).filter(({ server, gpu }) => {
    const snapshot = snapshots[server.id]
    if (filters.targetServerId && server.id !== filters.targetServerId) return false
    if (filters.targetGpuUuid && gpu.uuid !== filters.targetGpuUuid) return false
    if (filters.gpuModel !== 'all' && gpu.name !== filters.gpuModel) return false
    if (filters.cpuModel !== 'all' && (snapshot?.system.cpuModel || '未知 CPU') !== filters.cpuModel) return false
    return filters.tag === 'all' || server.tags.includes(filters.tag)
  }).map(({ server, gpu }) => {
    const snapshot = snapshots[server.id]
    const freeCpuMemoryMb = Math.max(0, ((snapshot?.system.memoryTotalBytes ?? 0) - (snapshot?.system.memoryUsedBytes ?? 0)) / 1024 ** 2)
    const occupiedByOtherUser = hasOtherUserGpuWorkload(gpu, snapshot?.processes ?? [])
    const meetsProcess = filters.otherUserProcess === 'all' || !occupiedByOtherUser
    const freeGpuMemoryGb = displayedFreeMemoryGb(gpu.memoryTotalMb - gpu.memoryUsedMb)
    const freeCpuMemoryGb = displayedFreeMemoryGb(freeCpuMemoryMb)
    const meetsSnapshot = freeGpuMemoryGb >= filters.gpuMemoryGb && freeCpuMemoryGb >= filters.cpuMemoryGb && meetsProcess
    if (filters.duration <= 0) return { server, gpu, available: meetsSnapshot }
    const snapshotTime = snapshot?.timestamp ?? Math.floor(Date.now() / 1000)
    const cutoff = snapshotTime - filters.duration * 60
    const points = (history[server.id] ?? []).filter((point) => point.timestamp >= cutoff && point.timestamp <= snapshotTime)
    const coversWindow = points.length >= 2 && points[0].timestamp <= cutoff + Math.max(60, server.samplingIntervalSeconds * 3)
    const gpuTotalMb = Math.max(0, gpu.memoryTotalMb)
    const cpuTotalMb = Math.max(0, (snapshot?.system.memoryTotalBytes ?? 0) / 1024 ** 2)
    const meetsDuration = coversWindow && points.every((point) => {
      const historicalGpuFreeMb = gpuTotalMb * (1 - clampPercent(point.gpuMemoryUtilizations?.[gpu.uuid] ?? gpuMemoryPercent(gpu)) / 100)
      const historicalCpuFreeMb = cpuTotalMb * (1 - clampPercent(point.memoryUtilization) / 100)
      return displayedFreeMemoryGb(historicalGpuFreeMb) >= filters.gpuMemoryGb && displayedFreeMemoryGb(historicalCpuFreeMb) >= filters.cpuMemoryGb
    })
    return { server, gpu, available: meetsSnapshot && meetsDuration }
  }).sort((left, right) => Number(right.available) - Number(left.available)
    || (right.gpu.memoryTotalMb - right.gpu.memoryUsedMb) - (left.gpu.memoryTotalMb - left.gpu.memoryUsedMb)
    || ((snapshots[right.server.id]?.system.memoryTotalBytes ?? 0) - (snapshots[right.server.id]?.system.memoryUsedBytes ?? 0))
      - ((snapshots[left.server.id]?.system.memoryTotalBytes ?? 0) - (snapshots[left.server.id]?.system.memoryUsedBytes ?? 0)))
}
