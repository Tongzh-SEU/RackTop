import type { Snapshot } from '../types/models'

export const IGNORED_SYSTEM_MEMORY_KEY = 'racktop.ignoredSystemMemoryWarnings.v1'

export function systemMemoryThreshold(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(100, Math.max(80, value)) : 90
}

export function systemMemoryPercent(snapshot: Snapshot): number | null {
  const { memoryTotalBytes: total, memoryUsedBytes: used } = snapshot.system
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0 || used < 0 || used > total) return null
  return used / total * 100
}

export function hasSystemMemoryWarning(snapshot: Snapshot, threshold: number | undefined): boolean {
  const percent = systemMemoryPercent(snapshot)
  return percent !== null && percent > systemMemoryThreshold(threshold)
}

export function loadIgnoredSystemMemoryWarnings(): Set<string> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(IGNORED_SYSTEM_MEMORY_KEY) ?? '[]')
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
  } catch { return new Set() }
}
