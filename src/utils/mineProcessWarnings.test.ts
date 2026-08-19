import { describe, expect, it } from 'vitest'
import type { ProcessMetric, Snapshot } from '../types/models'
import { updateSharedGpuWarnings, type SharedGpuWatchMap } from './mineProcessWarnings'

const process = (pid: number, username: string, isCurrentUser: boolean): ProcessMetric => ({
  gpuUuid: 'gpu-0', gpuIndex: 0, pid, parentPid: 1, username, command: `python ${pid}.py`, memoryUsedMb: 3072, smUtilization: 0, cpuPercent: 0, elapsed: '00:10', isCurrentUser, isGroupLeader: true,
})

const snapshot = (processes: ProcessMetric[]): Snapshot => ({
  serverId: 'server-1', hostname: 'gpu-box', username: 'me', osId: 'linux', osName: 'Linux', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 1 },
  gpus: [{ index: 0, uuid: 'gpu-0', name: 'GPU', utilization: 0, memoryUtilization: 0, memoryUsedMb: 0, memoryTotalMb: 24_576, temperatureCelsius: 30, powerWatts: 20 }],
  processes, cpuProcesses: [],
})

describe('updateSharedGpuWarnings', () => {
  it('uses existing other-user processes as the baseline and only warns for newcomers', () => {
    const watches: SharedGpuWatchMap = new Map()
    const mine = process(100, 'me', true)
    const existing = process(200, 'alice', false)
    const newcomer = process(300, 'bob', false)

    expect(updateSharedGpuWarnings('训练机', snapshot([existing, mine]), watches)).toEqual([])
    expect(updateSharedGpuWarnings('训练机', snapshot([existing, mine, newcomer]), watches)).toEqual([
      expect.objectContaining({ message: '训练机 · GPU 0 新增占用：bob（PID 300）' }),
    ])
    expect(updateSharedGpuWarnings('训练机', snapshot([existing, mine, newcomer]), watches)).toHaveLength(1)
    expect(updateSharedGpuWarnings('训练机', snapshot([existing, mine]), watches)).toEqual([])
  })

  it('resets the baseline after the current user leaves the GPU', () => {
    const watches: SharedGpuWatchMap = new Map()
    const mine = process(100, 'me', true)
    const other = process(200, 'alice', false)

    updateSharedGpuWarnings('训练机', snapshot([mine]), watches)
    expect(updateSharedGpuWarnings('训练机', snapshot([mine, other]), watches)).toHaveLength(1)
    expect(updateSharedGpuWarnings('训练机', snapshot([other]), watches)).toEqual([])
    expect(updateSharedGpuWarnings('训练机', snapshot([mine, other]), watches)).toEqual([])
  })
})
