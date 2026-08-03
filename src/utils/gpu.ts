import type { GpuMetric } from '../types/models'

export type GpuLevel = 'idle' | 'active' | 'high' | 'critical'

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

export function gpuLoadLevel(utilization: number): GpuLevel {
  const safeUtilization = clampPercent(utilization)
  if (safeUtilization >= 95) return 'critical'
  if (safeUtilization >= 70) return 'high'
  if (safeUtilization >= 10) return 'active'
  return 'idle'
}

export function gpuLoadAccent(utilization: number): 'blue' | 'orange' | 'red' {
  const level = gpuLoadLevel(utilization)
  return level === 'critical' ? 'red' : level === 'high' ? 'orange' : 'blue'
}

export function gpuMemoryPercent(gpu: GpuMetric): number {
  if (gpu.memoryTotalMb <= 0) return 0
  return clampPercent(gpu.memoryUsedMb / gpu.memoryTotalMb * 100)
}

export function displayedGpuMemoryPercent(memoryPercent: number): number {
  const safePercent = clampPercent(memoryPercent)
  return safePercent < 1 ? 0 : Math.round(safePercent)
}

export function gpuMemoryLevel(memoryPercent: number): GpuLevel {
  if (memoryPercent >= 85) return 'critical'
  if (memoryPercent >= 50) return 'high'
  if (memoryPercent >= 1) return 'active'
  return 'idle'
}

export function isGpuIdle(gpu: GpuMetric, utilizationThreshold: number): boolean {
  return gpu.utilization < utilizationThreshold && gpuMemoryPercent(gpu) < 1
}
