import type { HistoryPoint, Server, Snapshot } from '../types/models'
import { countOtherUserGpuWorkloads, isGpuAvailable } from './gpu'
import { displayedFreeMemoryGb } from './idleFilters'

export type ResourceEligibilityStatus = 'eligible' | 'busy' | 'memory' | 'insufficient' | 'stale' | 'offline' | 'unavailable'

export interface ResourceRequirement {
  minimumGpuMemoryGb: number
  durationMinutes: number
  excludeOtherUsers: boolean
  snapshotFreshnessSeconds?: number
}

export interface ResourceEligibility {
  status: ResourceEligibilityStatus
  reasons: string[]
  evaluatedAt: number
}

export function evaluateResourceEligibility(
  server: Server,
  snapshot: Snapshot | undefined,
  gpuUuid: string,
  requirement: ResourceRequirement,
  history: HistoryPoint[] = [],
  nowSeconds = Math.floor(Date.now() / 1_000),
): ResourceEligibility {
  const evaluatedAt = nowSeconds
  if (server.status === 'offline') return { status: 'offline', reasons: ['服务器当前离线'], evaluatedAt }
  if (!snapshot) return { status: 'stale', reasons: ['尚未取得服务器快照'], evaluatedAt }
  const freshness = requirement.snapshotFreshnessSeconds ?? Math.max(30, server.samplingIntervalSeconds * 6)
  if (nowSeconds - snapshot.timestamp > freshness) return { status: 'stale', reasons: [`快照已超过 ${freshness} 秒`], evaluatedAt }
  const gpu = snapshot.gpus.find((item) => item.uuid === gpuUuid)
  if (!gpu || !isGpuAvailable(gpu)) return { status: 'unavailable', reasons: ['GPU 指标暂不可读'], evaluatedAt }
  const freeMemoryGb = displayedFreeMemoryGb(gpu.memoryTotalMb - gpu.memoryUsedMb)
  if (freeMemoryGb < requirement.minimumGpuMemoryGb) return { status: 'memory', reasons: [`空闲显存 ${freeMemoryGb.toFixed(1)} GB，要求 ${requirement.minimumGpuMemoryGb} GB`], evaluatedAt }
  const otherUserCount = countOtherUserGpuWorkloads(gpu, snapshot.processes)
  if (requirement.excludeOtherUsers && otherUserCount > 0) return { status: 'busy', reasons: [`检测到 ${otherUserCount} 个其他用户进程`], evaluatedAt }
  if (requirement.durationMinutes > 0) {
    const cutoff = snapshot.timestamp - requirement.durationMinutes * 60
    const covered = history.filter((point) => point.timestamp >= cutoff && point.timestamp <= snapshot.timestamp)
    if (covered.length < 2 || covered[0].timestamp > cutoff + Math.max(60, server.samplingIntervalSeconds * 3)) {
      return { status: 'insufficient', reasons: [`历史不足，无法证明连续 ${requirement.durationMinutes} 分钟满足条件`], evaluatedAt }
    }
  }
  return {
    status: 'eligible',
    reasons: [
      `空闲显存 ${freeMemoryGb.toFixed(1)} GB`,
      requirement.excludeOtherUsers ? '无其他用户进程' : '允许其他用户进程',
      requirement.durationMinutes > 0 ? `连续 ${requirement.durationMinutes} 分钟满足条件` : '当前快照满足条件',
    ],
    evaluatedAt,
  }
}
