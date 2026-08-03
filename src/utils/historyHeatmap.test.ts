import { describe, expect, it } from 'vitest'
import type { HistoryHeatmapPoint } from '../types/models'
import { buildHeatmapDays, heatmapBucketKey, heatmapLevel, historyHeatmapValue, indexHeatmapPoints } from './historyHeatmap'

const point: HistoryHeatmapPoint = {
  timestamp: new Date(2026, 7, 4, 6).getTime() / 1000,
  sampleCount: 120,
  cpuUtilization: 25,
  memoryUtilization: 40,
  gpuUtilizations: { 'GPU-0': 55 },
  gpuMemoryUtilizations: { 'GPU-0': 70 },
}

describe('history heatmap', () => {
  it('creates one day per column and caps the view at ninety days', () => {
    const days = buildHeatmapDays(new Date(2026, 7, 4, 12).getTime() / 1000, 3)
    expect(days.map((day) => day.key)).toEqual(['2026-08-02', '2026-08-03', '2026-08-04'])
    expect(buildHeatmapDays(point.timestamp, 120)).toHaveLength(90)
  })

  it('maps local time into three-hour rows', () => {
    expect(heatmapBucketKey(new Date(2026, 7, 4, 0).getTime() / 1000)).toBe('2026-08-04:0')
    expect(heatmapBucketKey(new Date(2026, 7, 4, 2, 59).getTime() / 1000)).toBe('2026-08-04:0')
    expect(heatmapBucketKey(new Date(2026, 7, 4, 3).getTime() / 1000)).toBe('2026-08-04:1')
    expect(indexHeatmapPoints([point]).get('2026-08-04:2')).toEqual(point)
  })

  it('selects CPU and GPU utilization or memory independently', () => {
    expect(historyHeatmapValue(point, 'cpu', 'utilization')).toBe(25)
    expect(historyHeatmapValue(point, 'cpu', 'memory')).toBe(40)
    expect(historyHeatmapValue(point, 'GPU-0', 'utilization')).toBe(55)
    expect(historyHeatmapValue(point, 'GPU-0', 'memory')).toBe(70)
    expect(historyHeatmapValue(point, 'GPU-missing', 'memory')).toBeNull()
    expect(heatmapLevel(0)).toBe(0)
    expect(heatmapLevel(81)).toBe(5)
  })
})
