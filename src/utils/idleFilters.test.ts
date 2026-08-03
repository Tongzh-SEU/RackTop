import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { DEFAULT_IDLE_FILTERS, normalizeIdleFilters, parseIdleFilters, rankIdleGpuItems } from './idleFilters'

const server: Server = {
  id: 'server-1', name: 'server-1', host: '10.0.0.1', port: 22, username: 'tongzh', tags: ['lab'],
  samplingIntervalSeconds: 2, historyRetentionDays: 30, authMethod: 'sshAgent', status: 'online',
}

const snapshot: Snapshot = {
  serverId: server.id, hostname: server.name, username: server.username, osId: 'linux', osName: 'Linux', timestamp: 1_000,
  status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [{ index: 0, uuid: 'gpu-0', name: 'Test GPU', utilization: 0, memoryUtilization: 0, memoryUsedMb: 2_048, memoryTotalMb: 24_576, temperatureCelsius: 30, powerWatts: 30 }],
  processes: [],
}

describe('idle filters', () => {
  it('restores valid persisted values and normalizes invalid fields', () => {
    expect(parseIdleFilters(JSON.stringify({ gpuMemoryGb: 12, cpuMemoryGb: 20, otherUserProcess: 'all', duration: 30, tag: 'lab' }))).toEqual({
      ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 12, cpuMemoryGb: 20, otherUserProcess: 'all', duration: 30, tag: 'lab',
    })
    expect(normalizeIdleFilters({ gpuMemoryGb: -10, duration: 12, otherUserProcess: 'invalid' })).toEqual(DEFAULT_IDLE_FILTERS)
    expect(parseIdleFilters('{invalid')).toEqual(DEFAULT_IDLE_FILTERS)
  })

  it('updates availability using the same persisted conditions as the idle page', () => {
    const snapshots = { [server.id]: snapshot }
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 20 })[0].available).toBe(true)
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, gpuMemoryGb: 23 })[0].available).toBe(false)
    expect(rankIdleGpuItems([server], snapshots, {}, { ...DEFAULT_IDLE_FILTERS, tag: 'other' })).toHaveLength(0)
  })
})
