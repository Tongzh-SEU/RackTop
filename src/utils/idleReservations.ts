import type { IdleReservation, IdleReservationFilters } from '../types/models'

export const CURRENT_SNAPSHOT_STABLE_SECONDS = 30

export function idleReservationGpuKey(serverId: string, gpuUuid: string): string {
  return `${serverId}:${gpuUuid}`
}

export function idleReservationFiltersEqual(left: IdleReservationFilters, right: IdleReservationFilters): boolean {
  return left.gpuMemoryGb === right.gpuMemoryGb
    && left.cpuMemoryGb === right.cpuMemoryGb
    && left.otherUserProcess === right.otherUserProcess
    && left.gpuModel === right.gpuModel
    && left.cpuModel === right.cpuModel
    && left.duration === right.duration
    && left.tag === right.tag
}

export function idleReservationSummary(filters: IdleReservationFilters): string {
  const parts = [`GPU MEM ≥ ${filters.gpuMemoryGb} GB`, `CPU MEM ≥ ${filters.cpuMemoryGb} GB`]
  parts.push(filters.otherUserProcess === 'all' ? '进程不限' : '无人占用')
  if (filters.gpuModel !== 'all') parts.push(filters.gpuModel.replace('NVIDIA ', ''))
  if (filters.cpuModel !== 'all') parts.push(filters.cpuModel)
  if (filters.tag !== 'all') parts.push(filters.tag)
  parts.push(filters.duration > 0 ? `持续 ${filters.duration} 分钟` : `稳定 ${CURRENT_SNAPSHOT_STABLE_SECONDS} 秒`)
  return parts.join(' · ')
}

export type IdleReservationEvaluation = {
  reservation: IdleReservation
  pendingSince: Record<string, number>
  notificationGpuKeys: string[]
  changed: boolean
}

export function evaluateIdleReservation(
  reservation: IdleReservation,
  matchingGpuKeys: string[],
  pendingSince: Record<string, number>,
  nowSeconds: number,
): IdleReservationEvaluation {
  if (reservation.status !== 'active') return { reservation, pendingSince, notificationGpuKeys: [], changed: false }
  if (reservation.expiresAt !== null && nowSeconds >= reservation.expiresAt) {
    return { reservation: { ...reservation, status: 'expired' }, pendingSince: {}, notificationGpuKeys: [], changed: true }
  }

  const matching = new Set(matchingGpuKeys)
  const latched = new Set(reservation.matchedGpuKeys)
  const nextPending = { ...pendingSince }
  let changed = false

  for (const key of [...latched]) {
    if (!matching.has(key)) {
      latched.delete(key)
      changed = true
    }
  }
  for (const key of Object.keys(nextPending)) {
    if (!matching.has(key) || latched.has(key)) delete nextPending[key]
  }

  const notificationGpuKeys: string[] = []
  const stableSeconds = reservation.filters.duration > 0 ? 0 : CURRENT_SNAPSHOT_STABLE_SECONDS
  let status: IdleReservation['status'] = reservation.status
  for (const key of matchingGpuKeys) {
    if (latched.has(key)) continue
    nextPending[key] ??= nowSeconds
    if (nowSeconds - nextPending[key] < stableSeconds) continue
    notificationGpuKeys.push(key)
    latched.add(key)
    delete nextPending[key]
    changed = true
    if (reservation.notifyMode === 'once') {
      status = 'completed'
      break
    }
  }

  const matchedGpuKeys = [...latched].sort()
  if (!changed && matchedGpuKeys.join('\0') !== [...reservation.matchedGpuKeys].sort().join('\0')) changed = true
  return {
    reservation: changed ? { ...reservation, status, matchedGpuKeys } : reservation,
    pendingSince: nextPending,
    notificationGpuKeys,
    changed,
  }
}
