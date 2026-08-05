import type { GpuMemoryStallWarning, Server, Snapshot } from '../types/models'

export const GPU_MEMORY_STALL_SECONDS = 60 * 60

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
    for (const gpu of snapshot.gpus) {
      const id = `gpu-memory-stall:${server.id}:${gpu.uuid}`
      if (!(gpu.memoryUsedMb > 0 && gpu.utilization <= 0.5)) {
        delete since[id]
        continue
      }
      since[id] ??= snapshot.timestamp
      activeIds.add(id)
      if (now - since[id] < GPU_MEMORY_STALL_SECONDS || ignoredIds.has(id)) continue
      warnings.push({
        id,
        serverId: server.id,
        serverName: server.name,
        gpuUuid: gpu.uuid,
        gpuIndex: gpu.index,
        gpuName: gpu.name,
        usernames: [...new Set(snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid && process.memoryUsedMb > 0).map((process) => process.username))],
        memoryUsedMb: gpu.memoryUsedMb,
        memoryTotalMb: gpu.memoryTotalMb,
        startedAt: since[id],
        durationSeconds: Math.max(0, now - since[id]),
      })
    }
  }
  for (const id of Object.keys(since)) if (!activeIds.has(id)) delete since[id]
  return { warnings, since }
}
