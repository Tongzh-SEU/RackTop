import { describe, expect, it } from 'vitest'
import type { HistoryPoint, Server, Snapshot } from '../types/models'
import { DEFAULT_IDLE_FILTERS, displayedFreeMemoryGb, idleFilterSummaryParts, normalizeIdleFilters, parseIdleFilters, rankIdleGpuItems } from './idleFilters'

const server: Server = {
  id: 'server-1', name: 'server-1', host: '10.0.0.1', port: 22, username: 'tongzh', tags: ['lab'],
  samplingIntervalSeconds: 2, historyRetentionDays: 30, remoteHistoryEnabled: false, authMethod: 'sshAgent', status: 'online',
}

const snapshot: Snapshot = {
  serverId: server.id, hostname: server.name, username: server.username, osId: 'linux', osName: 'Linux', timestamp: 1_000,
  status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [{ index: 0, uuid: 'gpu-0', name: 'Test GPU', utilization: 0, memoryUtilization: 0, memoryUsedMb: 512, memoryTotalMb: 24_576, temperatureCelsius: 30, powerWatts: 30 }],
  processes: [],
  cpuProcesses: [],
}

describe('idle filters', () => {
  it('restores valid persisted values and normalizes invalid fields', () => {
    expect(parseIdleFilters(JSON.stringify({ gpuMemoryGb: 12, cpuMemoryGb: 20, otherUserProcess: 'all', duration: 30, tag: 'lab' }))).toEqual({
      ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 12, cpuMemoryGb: 20, otherUserProcess: 'all', duration: 30, tag: 'lab',
    })
    expect(normalizeIdleFilters({ gpuMemoryGb: -10, duration: 12, otherUserProcess: 'invalid' })).toEqual(DEFAULT_IDLE_FILTERS)
    expect(normalizeIdleFilters({ otherUserProcess: 'without' })).toEqual(DEFAULT_IDLE_FILTERS)
    expect(parseIdleFilters('{invalid')).toEqual(DEFAULT_IDLE_FILTERS)
  })

  it('updates availability using the same persisted conditions as the idle page', () => {
    const snapshots = { [server.id]: snapshot }
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 20 })[0].available).toBe(true)
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 24 })[0].available).toBe(false)
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, tag: 'other' })).toHaveLength(0)
  })

  it('adds model and tag summaries only after an explicit selection', () => {
    expect(idleFilterSummaryParts(DEFAULT_IDLE_FILTERS)).toEqual(['GPU MEM ≥ 0 GB', 'CPU MEM ≥ 0 GB', '无人占用', '当前快照'])
    expect(idleFilterSummaryParts({ ...DEFAULT_IDLE_FILTERS, gpuModel: 'NVIDIA A100', cpuModel: 'AMD Ryzen 9', tag: '实验室' })).toEqual([
      'GPU MEM ≥ 0 GB', 'CPU MEM ≥ 0 GB', '无人占用', 'A100', 'AMD Ryzen 9', '当前快照', '实验室',
    ])
  })

  it('distinguishes nobody, no other users, and unrestricted occupancy', () => {
    const occupiedGpu = { ...snapshot.gpus[0], memoryUsedMb: 8_192, memoryUtilization: 33.3 }
    const ownProcess = { gpuUuid: occupiedGpu.uuid, gpuIndex: 0, pid: 10, parentPid: 1, username: 'tongzh', command: 'train', memoryUsedMb: 8_192, smUtilization: 50, cpuPercent: 0, elapsed: '1m', isCurrentUser: true, isGroupLeader: true }
    const ownSnapshot = { ...snapshot, gpus: [occupiedGpu], processes: [ownProcess] }
    const otherSnapshot = { ...ownSnapshot, processes: [{ ...ownProcess, username: 'alice', isCurrentUser: false }] }

    expect(rankIdleGpuItems([server], { [server.id]: ownSnapshot }, {}, DEFAULT_IDLE_FILTERS)[0].available).toBe(false)
    expect(rankIdleGpuItems([server], { [server.id]: ownSnapshot }, {}, { ...DEFAULT_IDLE_FILTERS, otherUserProcess: 'withoutOthers' })[0].available).toBe(true)
    expect(rankIdleGpuItems([server], { [server.id]: otherSnapshot }, {}, { ...DEFAULT_IDLE_FILTERS, otherUserProcess: 'withoutOthers' })[0].available).toBe(false)
    expect(rankIdleGpuItems([server], { [server.id]: otherSnapshot }, {}, { ...DEFAULT_IDLE_FILTERS, otherUserProcess: 'all' })[0].available).toBe(true)
  })

  it('uses the displayed one-decimal memory value at the filter boundary', () => {
    const boundarySnapshot = {
      ...snapshot,
      gpus: [{ ...snapshot.gpus[0], memoryTotalMb: 40_960, memoryUsedMb: 12 }],
    }
    const snapshots = { [server.id]: boundarySnapshot }

    expect(displayedFreeMemoryGb(40_960 - 12)).toBe(40)
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 40 })[0].available).toBe(true)
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 40.1 })[0].available).toBe(false)
  })

  it('excludes unreadable GPU placeholders from idle and reservation results', () => {
    const unavailableSnapshot = {
      ...snapshot,
      nvidiaSmi: 'degraded' as const,
      gpus: [...snapshot.gpus, { ...snapshot.gpus[0], index: 1, uuid: 'unavailable-0000_D1_00_0', name: 'Unavailable GPU (0000:D1:00.0)', memoryUsedMb: 0, memoryTotalMb: 0 }],
    }
    const items = rankIdleGpuItems([server], { [server.id]: unavailableSnapshot }, {}, DEFAULT_IDLE_FILTERS)
    expect(items.map((item) => item.gpu.uuid)).toEqual(['gpu-0'])
  })

  it('requires a complete duration window with anonymous process coverage', () => {
    const durationSnapshot = { ...snapshot, timestamp: 10_000 }
    const snapshots = { [server.id]: durationSnapshot }
    const fullHistory = Array.from({ length: 61 }, (_, index) => ({
      timestamp: durationSnapshot.timestamp - (60 - index) * 60,
      cpuUtilization: 0,
      memoryUtilization: 25,
      swapUtilization: 0,
      gpuUtilizations: { 'gpu-0': 0 },
      gpuMemoryUtilizations: { 'gpu-0': 8 },
      gpuOtherUserOccupancies: { 'gpu-0': false },
    }))
    const filters = { ...DEFAULT_IDLE_FILTERS, duration: 60, otherUserProcess: 'withoutOthers' as const }

    expect(rankIdleGpuItems([server], snapshots, { [server.id]: fullHistory }, filters)[0].available).toBe(true)
    expect(rankIdleGpuItems([server], snapshots, { [server.id]: fullHistory.slice(30) }, filters)[0].available).toBe(false)
  })

  it('rejects occupied or unknown process samples across the duration window', () => {
    const durationSnapshot = { ...snapshot, timestamp: 10_000 }
    const snapshots = { [server.id]: durationSnapshot }
    const fullHistory = Array.from({ length: 61 }, (_, index) => ({
      timestamp: durationSnapshot.timestamp - (60 - index) * 60,
      cpuUtilization: 0,
      memoryUtilization: 25,
      swapUtilization: 0,
      gpuUtilizations: { 'gpu-0': 0 },
      gpuMemoryUtilizations: { 'gpu-0': 8 },
      gpuOtherUserOccupancies: { 'gpu-0': index === 30 },
    }))
    const filters = { ...DEFAULT_IDLE_FILTERS, duration: 60, otherUserProcess: 'withoutOthers' as const }

    expect(rankIdleGpuItems([server], snapshots, { [server.id]: fullHistory }, filters)[0].available).toBe(false)
    const unknownHistory = fullHistory.map((point) => ({ ...point, gpuOtherUserOccupancies: undefined }))
    expect(rankIdleGpuItems([server], snapshots, { [server.id]: unknownHistory }, filters)[0].available).toBe(false)
    expect(rankIdleGpuItems([server], snapshots, { [server.id]: unknownHistory }, { ...filters, otherUserProcess: 'all' })[0].available).toBe(true)
  })

  it('accepts sparse process samples when they cover the requested window', () => {
    const durationSnapshot = { ...snapshot, timestamp: 10_000 }
    const snapshots = { [server.id]: durationSnapshot }
    const history: HistoryPoint[] = Array.from({ length: 151 }, (_, index) => ({
      timestamp: durationSnapshot.timestamp - (150 - index) * 2,
      cpuUtilization: 0,
      memoryUtilization: 25,
      swapUtilization: 0,
      gpuUtilizations: { 'gpu-0': 0 },
      gpuMemoryUtilizations: { 'gpu-0': 8 },
      gpuOtherUserOccupancies: index % 4 === 0 ? { 'gpu-0': false } : undefined,
    }))
    const filters = { ...DEFAULT_IDLE_FILTERS, duration: 5, otherUserProcess: 'withoutOthers' as const }

    expect(rankIdleGpuItems([server], snapshots, { [server.id]: history }, filters)[0].available).toBe(true)
    const staleProcessHistory = history.map((point, index) => ({ ...point, gpuOtherUserOccupancies: index < 110 ? point.gpuOtherUserOccupancies : undefined }))
    expect(rankIdleGpuItems([server], snapshots, { [server.id]: staleProcessHistory }, filters)[0].available).toBe(false)
  })
})
