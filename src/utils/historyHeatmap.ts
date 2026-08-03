import type { HistoryHeatmapPoint } from '../types/models'
import { clampPercent } from './gpu'

export const HEATMAP_BUCKET_HOURS = 3
export const HEATMAP_ROWS_PER_DAY = 24 / HEATMAP_BUCKET_HOURS

export interface HeatmapDay {
  key: string
  timestamp: number
  label: string
  fullLabel: string
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function heatmapBucketKey(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return `${localDateKey(timestamp)}:${Math.floor(date.getHours() / HEATMAP_BUCKET_HOURS)}`
}

export function buildHeatmapDays(nowTimestamp: number, requestedDays: number): HeatmapDay[] {
  const dayCount = Math.max(1, Math.min(90, Math.floor(requestedDays)))
  const end = new Date(nowTimestamp * 1000)
  end.setHours(0, 0, 0, 0)
  return Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(end)
    date.setDate(end.getDate() - (dayCount - index - 1))
    return {
      key: localDateKey(date.getTime() / 1000),
      timestamp: date.getTime() / 1000,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      fullLabel: `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`,
    }
  })
}

export function indexHeatmapPoints(points: HistoryHeatmapPoint[]): Map<string, HistoryHeatmapPoint> {
  return new Map(points.map((point) => [heatmapBucketKey(point.timestamp), point]))
}

export function historyHeatmapValue(point: HistoryHeatmapPoint, resource: 'cpu' | string, metric: 'utilization' | 'memory'): number | null {
  const raw = resource === 'cpu'
    ? (metric === 'utilization' ? point.cpuUtilization : point.memoryUtilization)
    : (metric === 'utilization' ? point.gpuUtilizations[resource] : point.gpuMemoryUtilizations[resource])
  return raw === undefined || raw === null || !Number.isFinite(raw) ? null : clampPercent(raw)
}

export function heatmapLevel(value: number): number {
  const safe = clampPercent(value)
  if (safe === 0) return 0
  return Math.min(5, Math.ceil(safe / 20))
}
