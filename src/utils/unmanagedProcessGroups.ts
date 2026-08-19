import type { CpuProcessMetric, ProcessMetric, Snapshot } from '../types/models'
import { processTaskRootPid } from './processRelations'

export type ObservedProcess = ProcessMetric | CpuProcessMetric

export interface UnmanagedProcessGroup {
  rootPid: number
  root: ObservedProcess
  processes: ObservedProcess[]
  gpuUuids: string[]
  gpuIndices: number[]
  gpuMemoryMb: number
  cpuPercent: number
  systemMemoryMb: number
  elapsed: string
}

export function isGpuProcess(process: ObservedProcess): process is ProcessMetric {
  return 'gpuUuid' in process
}

export function elapsedSeconds(value: string) {
  const match = value.trim().match(/^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/)
  if (!match) return 0
  const days = Number(match[1] ?? 0)
  const hasHours = match[4] != null
  const hours = hasHours ? Number(match[2]) : 0
  const minutes = hasHours ? Number(match[3]) : Number(match[2])
  const seconds = hasHours ? Number(match[4]) : Number(match[3])
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

export function unmanagedProcessGroups(snapshot: Snapshot): UnmanagedProcessGroup[] {
  const byPid = new Map<number, ObservedProcess>()
  for (const process of snapshot.cpuProcesses) byPid.set(process.pid, process)
  // GPU samples contain both GPU and CPU usage, so prefer them when a PID appears in both lists.
  for (const process of snapshot.processes) byPid.set(process.pid, process)

  const grouped = new Map<number, ObservedProcess[]>()
  for (const process of byPid.values()) {
    const rootPid = processTaskRootPid(process, snapshot)
    grouped.set(rootPid, [...(grouped.get(rootPid) ?? []), process])
  }

  return [...grouped.entries()].map(([rootPid, members]) => {
    const root = byPid.get(rootPid) ?? members[0]
    const processes = [...members].sort((left, right) => left.pid === rootPid ? -1 : right.pid === rootPid ? 1 : left.pid - right.pid)
    const gpuProcesses = processes.filter(isGpuProcess)
    const cpuProcesses = processes.filter((process): process is CpuProcessMetric => !isGpuProcess(process))
    return {
      rootPid,
      root,
      processes,
      gpuUuids: [...new Set(gpuProcesses.map((process) => process.gpuUuid))],
      gpuIndices: [...new Set(gpuProcesses.map((process) => process.gpuIndex))].sort((left, right) => left - right),
      gpuMemoryMb: gpuProcesses.reduce((sum, process) => sum + process.memoryUsedMb, 0),
      cpuPercent: processes.reduce((sum, process) => sum + process.cpuPercent, 0),
      systemMemoryMb: cpuProcesses.reduce((sum, process) => sum + process.memoryUsedBytes / 1024 ** 2, 0),
      elapsed: root.elapsed,
    }
  }).sort((left, right) => left.rootPid - right.rootPid)
}
