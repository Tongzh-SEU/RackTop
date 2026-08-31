import type { CpuProcessMetric, ProcessMetric, Snapshot } from '../types/models'

export function currentUserProcessCount(snapshot: Snapshot) {
  const pids = new Set(snapshot.processes.filter((process) => process.isCurrentUser).map((process) => process.pid))
  for (const process of snapshot.cpuProcesses) if (process.isCurrentUser) pids.add(process.pid)
  return pids.size
}

export function visibleCurrentUserCpuUtilization(snapshot: Snapshot) {
  return currentUserProcessCount(snapshot) > 0 ? snapshot.system.currentUserCpuUtilization : 0
}

export function processTaskRootPid(process: ProcessMetric | CpuProcessMetric, snapshot: Snapshot) {
  const byPid = new Map<number, ProcessMetric | CpuProcessMetric>()
  for (const candidate of [...snapshot.processes, ...snapshot.cpuProcesses]) byPid.set(candidate.pid, candidate)
  let current = process
  let rootPid = process.pid
  const visited = new Set<number>([process.pid])
  while (current.parentPid > 1) {
    const parent = byPid.get(current.parentPid)
    if (!parent || visited.has(parent.pid)) break
    visited.add(parent.pid)
    rootPid = parent.pid
    current = parent
  }
  return rootPid
}

export function cpuChildrenOfGpu(process: ProcessMetric, cpuProcesses: CpuProcessMetric[]) {
  return cpuProcesses.filter((candidate) => candidate.parentPid === process.pid)
}

export function gpuProcessRelation(process: ProcessMetric, snapshot: Snapshot) {
  const children = cpuChildrenOfGpu(process, snapshot.cpuProcesses)
  if (children.length === 1) return `CPU 子进程 PID ${children[0].pid}`
  if (children.length > 1) return `${children.length} 个 CPU 子进程`

  const gpuParent = snapshot.processes.find((candidate) => candidate.pid === process.parentPid)
  if (gpuParent) return `GPU ${gpuParent.gpuIndex} · PID ${gpuParent.pid} 的子进程`
  const cpuParent = snapshot.cpuProcesses.find((candidate) => candidate.pid === process.parentPid)
  if (cpuParent) return `CPU PID ${cpuParent.pid} 的子进程`
  return process.parentPid > 0 ? `父 PID ${process.parentPid}` : '未识别父进程'
}

export function cpuProcessRelation(process: CpuProcessMetric, snapshot: Snapshot) {
  const gpuParent = snapshot.processes.find((candidate) => candidate.pid === process.parentPid)
  if (gpuParent) return `GPU ${gpuParent.gpuIndex} · PID ${gpuParent.pid} 的子进程`
  const cpuParent = snapshot.cpuProcesses.find((candidate) => candidate.pid === process.parentPid)
  if (cpuParent) return `CPU PID ${cpuParent.pid} 的子进程`
  return process.parentPid > 0 ? `父 PID ${process.parentPid}` : '未识别父进程'
}
