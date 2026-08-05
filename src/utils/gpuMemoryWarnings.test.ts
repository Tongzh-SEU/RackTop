import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { deriveGpuMemoryStallWarnings, GPU_MEMORY_STALL_SECONDS } from './gpuMemoryWarnings'

const server = { id: 's1', name: '训练机', host: 'host', port: 22, username: 'me', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent', status: 'online' } as Server
const snapshot = (timestamp: number, utilization: number, memoryUsedMb = 4096): Snapshot => ({ serverId: 's1', hostname: 'host', username: 'me', osId: 'linux', osName: 'Linux', timestamp, status: 'online', system: { cpuModel: 'CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 1 }, gpus: [{ index: 0, uuid: 'gpu-0', name: 'NVIDIA A100', utilization, memoryUtilization: memoryUsedMb / 8192 * 100, memoryUsedMb, memoryTotalMb: 8192, temperatureCelsius: 40, powerWatts: 100 }], disks: [], processes: [{ gpuUuid: 'gpu-0', gpuIndex: 0, pid: 1, parentPid: 1, username: 'alice', command: 'train', memoryUsedMb, smUtilization: 0, cpuPercent: 0, elapsed: '1h', isCurrentUser: false, isGroupLeader: true }], cpuProcesses: [], processesSampled: true, nvidiaSmi: 'available' })

describe('deriveGpuMemoryStallWarnings', () => {
  it('starts timing and warns only after one hour', () => {
    const first = deriveGpuMemoryStallWarnings([server], { s1: snapshot(1000, 0) }, {}, new Set(), 1000)
    expect(first.warnings).toHaveLength(0)
    const second = deriveGpuMemoryStallWarnings([server], { s1: snapshot(1000 + GPU_MEMORY_STALL_SECONDS, 0) }, first.since, new Set(), 1000 + GPU_MEMORY_STALL_SECONDS)
    expect(second.warnings[0]).toMatchObject({ serverName: '训练机', gpuIndex: 0, usernames: ['alice'] })
  })

  it('clears when utilization returns and respects ignore', () => {
    const since = { 'gpu-memory-stall:s1:gpu-0': 1000 }
    expect(deriveGpuMemoryStallWarnings([server], { s1: snapshot(1100, 5) }, since, new Set(), 1100).since).toEqual({})
    expect(deriveGpuMemoryStallWarnings([server], { s1: snapshot(1000 + GPU_MEMORY_STALL_SECONDS, 0) }, since, new Set(['gpu-memory-stall:s1:gpu-0']), 1000 + GPU_MEMORY_STALL_SECONDS).warnings).toHaveLength(0)
  })

  it('warns even when the driver cannot attribute occupied memory to a process', () => {
    const withoutProcesses = { ...snapshot(1000 + GPU_MEMORY_STALL_SECONDS, 0, 9216), processes: [] }
    const result = deriveGpuMemoryStallWarnings([server], { s1: withoutProcesses }, { 'gpu-memory-stall:s1:gpu-0': 1000 }, new Set(), 1000 + GPU_MEMORY_STALL_SECONDS)
    expect(result.warnings[0]).toMatchObject({ memoryUsedMb: 9216, usernames: [] })
  })

  it('uses each server snapshot time instead of another server latest time', () => {
    const other = { ...server, id: 's2', name: '新鲜服务器' }
    const stale = snapshot(1100, 0)
    const fresh = { ...snapshot(5000, 0), serverId: 's2' }
    const result = deriveGpuMemoryStallWarnings([server, other], { s1: stale, s2: fresh }, { 'gpu-memory-stall:s1:gpu-0': 1000 }, new Set(), 5000)
    expect(result.warnings.some((warning) => warning.serverId === 's1')).toBe(false)
  })

  it('warns immediately for a defunct process that still occupies GPU memory', () => {
    const withDefunct = { ...snapshot(1000, 0), processes: [{ ...snapshot(1000, 0).processes[0], pid: 4242, command: '[python] <defunct>' }] }
    const result = deriveGpuMemoryStallWarnings([server], { s1: withDefunct }, {}, new Set(), 1000)
    expect(result.warnings[0]).toMatchObject({
      defunctProcesses: [{ pid: 4242, username: 'alice' }],
      durationSeconds: 0,
    })
  })

  it('does not time negligible driver memory as a stalled workload', () => {
    const result = deriveGpuMemoryStallWarnings([server], { s1: snapshot(1000, 0, 4) }, {}, new Set(), 1000 + GPU_MEMORY_STALL_SECONDS)
    expect(result.warnings).toEqual([])
    expect(result.since).toEqual({})
  })
})
