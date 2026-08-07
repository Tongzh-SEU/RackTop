import type { GpuMemoryStallWarning, Server, Snapshot } from '../types/models'

export const GPU_MEMORY_STALL_SECONDS = 60 * 60
const GPU_MEMORY_STALL_MINIMUM_MB = 1024

export function gpuMemoryStallWarningId(serverId: string, gpuUuid: string) {
  return `gpu-memory-stall:${serverId}:${gpuUuid}`
}

export function ignoredGpuMemoryStallGpus(serverId: string, snapshot: Pick<Snapshot, 'gpus'>, ignoredIds: Set<string>) {
  return snapshot.gpus.filter((gpu) => ignoredIds.has(gpuMemoryStallWarningId(serverId, gpu.uuid)))
}

export function deriveGpuMemoryStallWarnings(
  servers: Server[],
  snapshots: Record<string, Snapshot>,
  previousSince: Record<string, number>,
  ignoredIds: Set<string>,
  now: number,
): { warnings: GpuMemoryStallWarning[]; since: Record<string, number> } {
  const since = { ...previousSince }
  const activeIds = new Set<string>()
  const warnings: GpuMemoryStallWarning[] = []
  for (const server of servers) {
    const snapshot = snapshots[server.id]
    if (!snapshot) continue
    const observedAt = Math.min(now, snapshot.timestamp)
    for (const gpu of snapshot.gpus) {
      const id = gpuMemoryStallWarningId(server.id, gpu.uuid)
      const gpuProcesses = snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid && process.memoryUsedMb > 0)
      const defunctProcesses = gpuProcesses.filter((process) => process.command.toLowerCase().includes('<defunct>'))
      if (!(gpu.memoryUsedMb >= GPU_MEMORY_STALL_MINIMUM_MB && gpu.utilization <= 0.5)) {
        delete since[id]
        continue
      }
      since[id] ??= snapshot.timestamp
      activeIds.add(id)
      if ((defunctProcesses.length === 0 && observedAt - since[id] < GPU_MEMORY_STALL_SECONDS) || ignoredIds.has(id)) continue
      warnings.push({
        id,
        serverId: server.id,
        serverName: server.name,
        gpuUuid: gpu.uuid,
        gpuIndex: gpu.index,
        gpuName: gpu.name,
        usernames: [...new Set(gpuProcesses.map((process) => process.username))],
        defunctProcesses: defunctProcesses.map((process) => ({ pid: process.pid, username: process.username })),
        memoryUsedMb: gpu.memoryUsedMb,
        memoryTotalMb: gpu.memoryTotalMb,
        startedAt: since[id],
        durationSeconds: Math.max(0, observedAt - since[id]),
      })
    }
  }
  for (const id of Object.keys(since)) if (!activeIds.has(id)) delete since[id]
  return { warnings, since }
}
