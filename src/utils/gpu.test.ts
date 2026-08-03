import { describe, expect, it } from 'vitest'
import type { GpuMetric } from '../types/models'
import { clampPercent, displayedGpuMemoryPercent, gpuMemoryLevel, gpuMemoryPercent, isGpuIdle } from './gpu'

function gpu(memoryUsedMb: number, memoryTotalMb = 40_960, utilization = 0): GpuMetric {
  return {
    index: 0,
    uuid: 'GPU-test',
    name: 'NVIDIA Test GPU',
    utilization,
    memoryUtilization: 0,
    memoryUsedMb,
    memoryTotalMb,
    temperatureCelsius: 30,
    powerWatts: 20,
  }
}

describe('GPU memory display semantics', () => {
  it('clamps invalid telemetry to a valid percentage', () => {
    expect(clampPercent(104.2)).toBe(100)
    expect(clampPercent(-3)).toBe(0)
    expect(clampPercent(Number.NaN)).toBe(0)
  })

  it('treats small system allocations below one percent as neutral zero', () => {
    const metric = gpu(409)
    const percent = gpuMemoryPercent(metric)
    expect(percent).toBeLessThan(1)
    expect(displayedGpuMemoryPercent(percent)).toBe(0)
    expect(gpuMemoryLevel(percent)).toBe('idle')
    expect(isGpuIdle(metric, 10)).toBe(true)
  })

  it('starts the occupied color range at one percent', () => {
    const metric = gpu(409.6)
    const percent = gpuMemoryPercent(metric)
    expect(percent).toBeCloseTo(1)
    expect(displayedGpuMemoryPercent(percent)).toBe(1)
    expect(gpuMemoryLevel(percent)).toBe('active')
    expect(isGpuIdle(metric, 10)).toBe(false)
  })

  it('keeps core utilization as an independent idle condition', () => {
    expect(isGpuIdle(gpu(14, 40_960, 10), 10)).toBe(false)
    expect(isGpuIdle(gpu(14, 40_960, 9.9), 10)).toBe(true)
  })

  it('uses orange and red memory thresholds', () => {
    expect(gpuMemoryLevel(49.9)).toBe('active')
    expect(gpuMemoryLevel(50)).toBe('high')
    expect(gpuMemoryLevel(84.9)).toBe('high')
    expect(gpuMemoryLevel(85)).toBe('critical')
  })
})
