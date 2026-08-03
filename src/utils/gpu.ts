import type { GpuMetric, ProcessMetric } from '../types/models'

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

export function formatGpuProcessMemory(memoryUsedMb: number): string {
  const safeMemoryMb = Number.isFinite(memoryUsedMb) ? Math.max(0, memoryUsedMb) : 0
  return safeMemoryMb > 1024 ? `${(safeMemoryMb / 1024).toFixed(1)} GB` : `${Math.round(safeMemoryMb)} MB`
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

export function hasEnoughFreeGpuMemory(gpu: GpuMetric, minimumFreeMemoryMb: number): boolean {
  const freeMemoryMb = Math.max(0, gpu.memoryTotalMb - gpu.memoryUsedMb)
  return freeMemoryMb >= Math.max(0, minimumFreeMemoryMb)
}

const SYSTEM_GPU_USERS = new Set(['gdm', 'lightdm', 'sddm', 'display', 'nvidia-persistenced'])
const SYSTEM_GPU_COMMAND = /(?:^|\/)(?:Xorg|Xwayland|gnome-shell|kwin_wayland|kwin_x11|nvidia-persistenced|nvidia-powerd)(?:\s|$)/i

export function isIgnoredSystemGpuProcess(process: ProcessMetric): boolean {
  return SYSTEM_GPU_USERS.has(process.username.trim().toLowerCase()) || SYSTEM_GPU_COMMAND.test(process.command.trim())
}

export function hasOtherUserGpuWorkload(gpu: GpuMetric, processes: ProcessMetric[]): boolean {
  if (gpu.memoryTotalMb <= 0) return false
  const otherUserMemoryMb = processes
    .filter((process) => process.gpuUuid === gpu.uuid && !process.isCurrentUser && !isIgnoredSystemGpuProcess(process))
    .reduce((sum, process) => sum + Math.max(0, process.memoryUsedMb), 0)
  return otherUserMemoryMb / gpu.memoryTotalMb * 100 > 3
}
