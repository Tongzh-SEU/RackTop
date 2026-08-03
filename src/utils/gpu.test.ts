import { describe, expect, it } from 'vitest'
import type { GpuMetric, ProcessMetric } from '../types/models'
import { aggregateGpuMemoryPercent, clampPercent, displayedGpuMemoryPercent, formatGpuProcessMemory, gpuMemoryLevel, gpuMemoryPercent, hasEnoughFreeGpuMemory, hasOtherUserGpuWorkload, isGpuIdle, isIgnoredSystemGpuProcess } from './gpu'

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

function process(username: string, memoryUsedMb: number, command = 'python train.py', isCurrentUser = false): ProcessMetric {
  return { gpuUuid: 'GPU-test', gpuIndex: 0, pid: 42, username, command, memoryUsedMb, cpuPercent: 0, elapsed: '00:10', isCurrentUser }
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

  it('weights aggregate GPU memory usage by device capacity', () => {
    const smallerGpu = gpu(10_240, 20_480)
    const largerGpu = gpu(20_480, 81_920)
    expect(aggregateGpuMemoryPercent([smallerGpu, largerGpu])).toBe(30)
    expect(aggregateGpuMemoryPercent([])).toBe(0)
  })

  it('uses orange and red memory thresholds', () => {
    expect(gpuMemoryLevel(49.9)).toBe('active')
    expect(gpuMemoryLevel(50)).toBe('high')
    expect(gpuMemoryLevel(84.9)).toBe('high')
    expect(gpuMemoryLevel(85)).toBe('critical')
  })

  it('formats process memory above one GB using GB', () => {
    expect(formatGpuProcessMemory(1024)).toBe('1024 MB')
    expect(formatGpuProcessMemory(1536)).toBe('1.5 GB')
    expect(formatGpuProcessMemory(37_682)).toBe('36.8 GB')
  })

  it('uses the visible free-memory condition without a hidden utilization condition', () => {
    const partiallyOccupied = gpu(11_943, 40_960, 0)
    expect(hasEnoughFreeGpuMemory(partiallyOccupied, 0)).toBe(true)
    expect(hasEnoughFreeGpuMemory(partiallyOccupied, 30 * 1024)).toBe(false)
    expect(hasEnoughFreeGpuMemory(gpu(0, 40_960, 100), 0)).toBe(true)
  })

  it('ignores display services and other-user allocations up to three percent', () => {
    const metric = gpu(0)
    expect(isIgnoredSystemGpuProcess(process('gdm', 10_000, '/usr/lib/xorg/Xorg'))).toBe(true)
    expect(hasOtherUserGpuWorkload(metric, [process('gdm', 10_000, '/usr/lib/xorg/Xorg')])).toBe(false)
    expect(hasOtherUserGpuWorkload(metric, [process('researcher', 40_960 * 0.03)])).toBe(false)
    expect(hasOtherUserGpuWorkload(metric, [process('researcher', 40_960 * 0.031)])).toBe(true)
    expect(hasOtherUserGpuWorkload(metric, [process('tongzh', 10_000, 'python train.py', true)])).toBe(false)
  })
})
