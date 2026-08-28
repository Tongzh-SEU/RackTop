import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { elapsedSeconds, unmanagedProcessGroups } from './unmanagedProcessGroups'

const snapshot: Snapshot = {
  serverId: 'server-a', hostname: 'gpu-a', username: 'tongzh', osId: 'linux', osName: 'Linux', timestamp: 1, status: 'online',
  system: { cpuModel: 'CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 1 },
  gpus: [], processesSampled: true, nvidiaSmi: 'available',
  processes: [
    { gpuUuid: 'gpu-0', gpuIndex: 0, pid: 100, parentPid: 1, username: 'tongzh', command: 'python train.py', memoryUsedMb: 5120, smUtilization: 50, cpuPercent: 12, elapsed: '01:02:03', isCurrentUser: true, isGroupLeader: true },
    { gpuUuid: 'gpu-1', gpuIndex: 1, pid: 102, parentPid: 101, username: 'tongzh', command: 'python worker.py', memoryUsedMb: 3072, smUtilization: 40, cpuPercent: 8, elapsed: '01:01:40', isCurrentUser: true, isGroupLeader: false },
  ],
  cpuProcesses: [
    { pid: 101, parentPid: 100, username: 'tongzh', command: 'python launcher.py', cpuPercent: 5, memoryPercent: 1, memoryUsedBytes: 1024 ** 3, elapsed: '01:02:00', isCurrentUser: true, isGroupLeader: false },
    { pid: 200, parentPid: 1, username: 'tongzh', command: 'python eval.py', cpuPercent: 3, memoryPercent: 0.5, memoryUsedBytes: 512 * 1024 ** 2, elapsed: '12:30', isCurrentUser: true, isGroupLeader: true },
  ],
}

describe('unmanagedProcessGroups', () => {
  it('groups descendants under the observed root PID and aggregates their resources', () => {
    const groups = unmanagedProcessGroups(snapshot)

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ rootPid: 100, gpuIndices: [0, 1], gpuMemoryMb: 8192, cpuPercent: 25, systemMemoryMb: 1024, elapsed: '01:02:03' })
    expect(groups[0].processes.map((process) => process.pid)).toEqual([100, 101, 102])
    expect(groups[1]).toMatchObject({ rootPid: 200, gpuIndices: [], cpuPercent: 3, systemMemoryMb: 512 })
  })

  it('parses ps elapsed values for adopted run start times', () => {
    expect(elapsedSeconds('12:30')).toBe(750)
    expect(elapsedSeconds('01:02:03')).toBe(3723)
    expect(elapsedSeconds('3-03:49:20')).toBe(272_960)
  })
})
