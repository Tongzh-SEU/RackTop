import type { AppSettings, Server, Snapshot } from '../types/models'
import { clampPercent, isGpuAvailable, isGpuIdle } from './gpu'
import { currentUserAcceleratorCount } from './processRelations'

export type FleetSort = 'name' | 'status' | 'gpuCount' | 'utilization' | 'idleCount' | 'myProcesses'
export type FleetSortMode = 'auto' | 'manual'

export const FLEET_SORT_MODE_STORAGE_KEY = 'racktop.fleetSortMode.v1'

export function initialFleetSortMode(sort: FleetSort, descending: boolean, storedMode: string | null): FleetSortMode {
  if (storedMode === 'manual') return 'manual'
  if (storedMode === 'auto') return 'auto'
  return sort !== 'name' || descending ? 'manual' : 'auto'
}

export function automaticFleetSort(snapshots: Record<string, Snapshot>): { sort: FleetSort; descending: boolean } {
  const hasCurrentUserAccelerator = Object.values(snapshots).some((snapshot) => currentUserAcceleratorCount(snapshot) > 0)
  return hasCurrentUserAccelerator ? { sort: 'myProcesses', descending: true } : { sort: 'name', descending: false }
}

function metric(server: Server, snapshots: Record<string, Snapshot>, settings: AppSettings | null) {
  const snapshot = snapshots[server.id]
  const readableGpus = snapshot?.gpus.filter(isGpuAvailable) ?? []
  const utilization = readableGpus.length ? readableGpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / readableGpus.length : -1
  return {
    gpuCount: snapshot?.gpus.length ?? -1,
    utilization,
    idleCount: snapshot?.gpus.filter((gpu) => isGpuIdle(gpu, settings?.idleGpuThreshold ?? 10)).length ?? -1,
    myProcesses: snapshot ? currentUserAcceleratorCount(snapshot) : -1,
    status: ({ online: 4, warning: 3, connecting: 2, unknown: 1, offline: 0 })[server.status],
  }
}

export function sortFleetServers(servers: Server[], snapshots: Record<string, Snapshot>, settings: AppSettings | null, sort: FleetSort, descending: boolean): Server[] {
  return [...servers].sort((left, right) => {
    if (sort === 'name') return (descending ? -1 : 1) * left.name.localeCompare(right.name, 'zh-CN')
    const leftMetric = metric(left, snapshots, settings)
    const rightMetric = metric(right, snapshots, settings)
    let comparison = leftMetric[sort] - rightMetric[sort]
    if (sort === 'myProcesses' && comparison === 0) comparison = leftMetric.gpuCount - rightMetric.gpuCount
    if (comparison !== 0) return descending ? -comparison : comparison
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}
