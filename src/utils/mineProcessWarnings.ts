import type { ProcessMetric, Snapshot } from '../types/models'

export interface MineProcessWarning {
  id: string
  serverId: string
  message: string
  tone: 'info' | 'warning'
}

interface SharedGpuWatch {
  knownOtherProcesses: Set<string>
  alertedOtherProcesses: Set<string>
}

export type SharedGpuWatchMap = Map<string, SharedGpuWatch>

function processKey(process: ProcessMetric) {
  return `${process.username}:${process.pid}`
}

export function updateSharedGpuWarnings(serverName: string, snapshot: Snapshot, watches: SharedGpuWatchMap): MineProcessWarning[] {
  const warnings: MineProcessWarning[] = []
  const activeGpuKeys = new Set<string>()

  for (const gpu of snapshot.gpus) {
    const ownProcesses = snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid && process.isCurrentUser)
    const watchKey = `${snapshot.serverId}:${gpu.uuid}`
    if (ownProcesses.length === 0) {
      watches.delete(watchKey)
      continue
    }

    activeGpuKeys.add(watchKey)
    const otherProcesses = snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid && !process.isCurrentUser)
    const currentOthers = new Map(otherProcesses.map((process) => [processKey(process), process]))
    const existing = watches.get(watchKey)
    if (!existing) {
      watches.set(watchKey, { knownOtherProcesses: new Set(currentOthers.keys()), alertedOtherProcesses: new Set() })
      continue
    }

    for (const key of existing.knownOtherProcesses) {
      if (!currentOthers.has(key)) {
        existing.knownOtherProcesses.delete(key)
        existing.alertedOtherProcesses.delete(key)
      }
    }
    for (const key of currentOthers.keys()) {
      if (!existing.knownOtherProcesses.has(key)) {
        existing.knownOtherProcesses.add(key)
        existing.alertedOtherProcesses.add(key)
      }
    }
    for (const key of existing.alertedOtherProcesses) {
      const process = currentOthers.get(key)
      if (process) warnings.push({
        id: `shared:${snapshot.serverId}:${gpu.uuid}:${key}`,
        serverId: snapshot.serverId,
        message: `${serverName} · GPU ${gpu.index} 新增占用：${process.username}（PID ${process.pid}）`,
        tone: 'warning',
      })
    }
  }

  for (const key of watches.keys()) {
    if (key.startsWith(`${snapshot.serverId}:`) && !activeGpuKeys.has(key)) watches.delete(key)
  }
  return warnings
}
