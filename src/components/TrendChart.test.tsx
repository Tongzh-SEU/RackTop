import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPoint, Snapshot } from '../types/models'

const captured = vi.hoisted(() => ({ option: null as { series: Array<{ id?: string }> } | null }))

vi.mock('echarts-for-react/lib/core', () => ({
  default: (props: { option: { series: Array<{ id?: string }> } }) => {
    captured.option = props.option
    return null
  },
}))

import { TrendChart } from './TrendChart'

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
  return captured.option?.series.map((series) => series.id)
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
})
