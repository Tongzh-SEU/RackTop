import type { CpuProcessMetric, ProcessMetric, Snapshot } from '../types/models'

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
