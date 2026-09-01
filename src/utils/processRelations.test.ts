import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { cpuChildrenOfGpu, cpuProcessRelation, currentUserAcceleratorCount, currentUserProcessCount, gpuProcessRelation, processTaskRootPid, visibleCurrentUserCpuUtilization } from './processRelations'

const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'gpu-box', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [],
  processes: [{ gpuUuid: 'gpu-0', gpuIndex: 0, pid: 21_312, parentPid: 1, username: 'tongzh', command: 'python train.py', memoryUsedMb: 1024, smUtilization: 73, cpuPercent: 20, elapsed: '01:00', isCurrentUser: true, isGroupLeader: true }],
  cpuProcesses: [
    { pid: 2_212, parentPid: 21_312, username: 'tongzh', command: 'python worker.py', cpuPercent: 10, memoryPercent: 1, memoryUsedBytes: 1024, elapsed: '00:30', isCurrentUser: true, isGroupLeader: false },
    { pid: 3_313, parentPid: 2_212, username: 'tongzh', command: 'python loader.py', cpuPercent: 5, memoryPercent: 0.5, memoryUsedBytes: 512, elapsed: '00:20', isCurrentUser: true, isGroupLeader: false },
  ],
}

describe('process relationships', () => {
  it('links a CPU child to its GPU parent in both directions', () => {
    expect(cpuChildrenOfGpu(snapshot.processes[0], snapshot.cpuProcesses).map((process) => process.pid)).toEqual([2_212])
    expect(gpuProcessRelation(snapshot.processes[0], snapshot)).toBe('CPU 子进程 PID 2212')
    expect(cpuProcessRelation(snapshot.cpuProcesses[0], snapshot)).toBe('GPU 0 · PID 21312 的子进程')
  })

  it('links nested CPU processes to their CPU parent', () => {
    expect(cpuProcessRelation(snapshot.cpuProcesses[1], snapshot)).toBe('CPU PID 2212 的子进程')
    expect(processTaskRootPid(snapshot.cpuProcesses[1], snapshot)).toBe(21_312)
  })

  it('counts one process once when it is reported on multiple GPUs or CPU telemetry', () => {
    const duplicateGpu = { ...snapshot.processes[0], gpuUuid: 'gpu-1', gpuIndex: 1 }
    const duplicateCpu = { ...snapshot.cpuProcesses[0], pid: snapshot.processes[0].pid, isGroupLeader: true }
    expect(currentUserProcessCount({ ...snapshot, processes: [...snapshot.processes, duplicateGpu], cpuProcesses: [...snapshot.cpuProcesses, duplicateCpu] })).toBe(3)
    expect(currentUserAcceleratorCount({ ...snapshot, processes: [...snapshot.processes, duplicateGpu] })).toBe(2)
  })

  it('hides background account CPU usage when no RackTop task is attributed to the current user', () => {
    const withoutCurrentUserTasks = {
      ...snapshot,
      system: { ...snapshot.system, currentUserCpuUtilization: 20.8 },
      processes: snapshot.processes.map((process) => ({ ...process, isCurrentUser: false })),
      cpuProcesses: snapshot.cpuProcesses.map((process) => ({ ...process, isCurrentUser: false })),
    }

    expect(visibleCurrentUserCpuUtilization(withoutCurrentUserTasks)).toBe(0)
    expect(visibleCurrentUserCpuUtilization({ ...snapshot, system: { ...snapshot.system, currentUserCpuUtilization: 20.8 } })).toBe(20.8)
  })
})
