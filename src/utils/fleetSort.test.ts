import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { automaticFleetSort, initialFleetSortMode, sortFleetServers } from './fleetSort'

const server = (id: string, name: string): Server => ({ id, name, host: id, port: 22, username: 'me', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 30, remoteHistoryEnabled: false, authMethod: 'sshAgent', status: 'online' })
const snapshot = (serverId: string, gpuCount: number, ownGpuIndexes: number[]): Snapshot => ({
  serverId, hostname: serverId, username: 'me', osId: 'linux', osName: 'Linux', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 1 },
  gpus: Array.from({ length: gpuCount }, (_, index) => ({ index, uuid: `${serverId}-gpu-${index}`, name: 'GPU', utilization: 0, memoryUtilization: 0, memoryUsedMb: 0, memoryTotalMb: 100, temperatureCelsius: 30, powerWatts: 10 })),
  processes: ownGpuIndexes.flatMap((gpuIndex, index) => [
    { gpuUuid: `${serverId}-gpu-${gpuIndex}`, gpuIndex, pid: index + 1, parentPid: 0, username: 'me', command: 'train', memoryUsedMb: 10, smUtilization: 0, cpuPercent: 0, elapsed: '1m', isCurrentUser: true, isGroupLeader: true },
    { gpuUuid: `${serverId}-gpu-${gpuIndex}`, gpuIndex, pid: index + 100, parentPid: 0, username: 'me', command: 'worker', memoryUsedMb: 10, smUtilization: 0, cpuPercent: 0, elapsed: '1m', isCurrentUser: true, isGroupLeader: true },
  ]),
  cpuProcesses: [],
})

describe('fleet sorting', () => {
  it('defaults to current-user accelerators only when one is occupied', () => {
    expect(automaticFleetSort({})).toEqual({ sort: 'name', descending: false })
    expect(automaticFleetSort({ a: snapshot('a', 4, [0]) })).toEqual({ sort: 'myProcesses', descending: true })
  })

  it('treats an old non-default selection as manual and the legacy default as automatic', () => {
    expect(initialFleetSortMode('name', false, null)).toBe('auto')
    expect(initialFleetSortMode('gpuCount', true, null)).toBe('manual')
    expect(initialFleetSortMode('name', false, 'manual')).toBe('manual')
  })

  it('counts unique occupied cards, then total cards, then server name', () => {
    const servers = [server('a', 'Alpha'), server('b', 'Beta'), server('c', 'Charlie')]
    const snapshots = {
      a: snapshot('a', 4, [0, 1]),
      b: snapshot('b', 8, [0, 1]),
      c: snapshot('c', 8, [0]),
    }
    expect(sortFleetServers(servers, snapshots, null, 'myProcesses', true).map(({ id }) => id)).toEqual(['b', 'a', 'c'])
  })
})
