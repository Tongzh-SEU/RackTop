import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPoint, Snapshot } from '../types/models'

const captured = vi.hoisted(() => ({ option: null as { series: Array<{ id?: string; data?: Array<[number, number | null]>; lineStyle?: { opacity?: number } }> } | null }))

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: { series: Array<{ id?: string; data?: Array<[number, number | null]>; lineStyle?: { opacity?: number } }> } }) => {
    captured.option = props.option
    return null
  },
}))
vi.mock('echarts/core', () => ({ use: vi.fn() }))
vi.mock('echarts/charts', () => ({ LineChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, LegendComponent: {}, MarkAreaComponent: {}, TooltipComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

import { missingTimeRanges, TrendChart, trendSeriesData } from './TrendChart'

const points: HistoryPoint[] = [{
  timestamp: 1,
  cpuUtilization: 12,
  memoryUtilization: 34,
  swapUtilization: 2,
  gpuUtilizations: { 'GPU-a': 56 },
  gpuMemoryUtilizations: { 'GPU-a': 78 },
}]

const snapshot = {
  system: { memoryTotalBytes: 64 * 1024 ** 3, swapTotalBytes: 8 * 1024 ** 3 },
  gpus: [{ uuid: 'GPU-a', index: 0, memoryTotalMb: 40960, memoryUsedMb: 20480 }],
} as Snapshot

function renderSeriesIds(mode: 'cpu' | 'systemMemory' | 'gpu' | 'gpuMemory') {
  renderToStaticMarkup(<TrendChart points={points} snapshot={snapshot} mode={mode} />)
  return captured.option?.series.map((series) => series.id).filter((id) => !id?.includes(':range-'))
}

describe('TrendChart series identity', () => {
  beforeEach(() => { captured.option = null })

  it('keeps CPU, system memory, and swap identities stable', () => {
    expect(renderSeriesIds('cpu')).toEqual(['cpu-utilization'])
    expect(renderSeriesIds('systemMemory')).toEqual(['system-memory-utilization', 'swap-utilization'])
  })

  it('uses separate stable identities for GPU utilization and memory', () => {
    expect(renderSeriesIds('gpu')).toEqual(['gpu-utilization:GPU-a'])
    expect(renderSeriesIds('gpuMemory')).toEqual(['gpu-memory:GPU-a'])
  })

  it('supports ten percent transparency for overview GPU lines', () => {
    renderToStaticMarkup(<TrendChart points={points} snapshot={snapshot} mode="gpu" seriesOpacity={0.9} />)
    expect(captured.option?.series.find((series) => series.id === 'gpu-utilization:GPU-a')?.lineStyle?.opacity).toBe(0.9)
  })

  it('breaks the line across unsampled periods instead of drawing a zero or continuous segment', () => {
    const separated = [points[0], { ...points[0], timestamp: points[0].timestamp + 10 * 60, cpuUtilization: 40 }]
    expect(trendSeriesData(separated, (point) => point.cpuUtilization)).toEqual([
      [1_000, 12],
      [301_000, null],
      [601_000, 40],
    ])
    expect(missingTimeRanges(separated)).toEqual([
      [{ xAxis: 61_000 }, { xAxis: 541_000 }],
    ])
  })

  it('keeps missing GPU metrics null instead of substituting zero or the current snapshot', () => {
    const missingGpuPoint = { ...points[0], gpuUtilizations: {}, gpuMemoryUtilizations: {} }
    renderToStaticMarkup(<TrendChart points={[missingGpuPoint]} snapshot={snapshot} mode="gpuMemory" />)
    expect(captured.option?.series.find((series) => series.id === 'gpu-memory:GPU-a')?.data).toEqual([[1_000, null]])
  })

  it('keeps regular ten minute tier points connected while preserving a peak range', () => {
    const tiered = Array.from({ length: 4 }, (_, index) => ({ ...points[0], timestamp: 1 + index * 10 * 60, isCompacted: true, cpuMin: 5, cpuMax: 80 }))
    renderToStaticMarkup(<TrendChart points={tiered} snapshot={snapshot} mode="cpu" />)
    expect(trendSeriesData(tiered, (point) => point.cpuUtilization)).toHaveLength(4)
    expect(captured.option?.series.find((series) => series.id === 'cpu-utilization:range-span')?.data?.[0]).toEqual([1_000, 75])
  })

  it('keeps compacted history connected when recent raw samples dominate the median interval', () => {
    const tiered = Array.from({ length: 6 }, (_, index) => ({ ...points[0], timestamp: 1 + index * 10 * 60, isCompacted: true }))
    const raw = Array.from({ length: 20 }, (_, index) => ({ ...points[0], timestamp: 1 + 5 * 10 * 60 + (index + 1) * 10 }))
    const mixed = [...tiered, ...raw]
    expect(trendSeriesData(mixed, (point) => point.cpuUtilization)).toHaveLength(mixed.length)
    expect(missingTimeRanges(mixed)).toEqual([])
  })

  it('calculates the gap distribution once when rendering thousands of raw samples', () => {
    const dense = Array.from({ length: 2_400 }, (_, index) => ({ ...points[0], timestamp: 1 + index * 5 }))
    const sort = vi.spyOn(Array.prototype, 'sort')
    renderToStaticMarkup(<TrendChart points={dense} snapshot={snapshot} mode="cpu" />)
    expect(sort).toHaveBeenCalledTimes(1)
    sort.mockRestore()
  })
})
