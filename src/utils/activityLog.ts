import type { Server, Snapshot } from '../types/models'
import { acceleratorLabel } from './accelerator'

export type InteractionVisualStatus = 'normal' | 'running' | 'error'

export function interactionVisualStatus(status: string, startedAt: number, now = Date.now()): InteractionVisualStatus {
  if (status === 'error') return 'error'
  if (status === 'running' && now - startedAt >= 1_000) return 'running'
  return 'normal'
}

export function interactionDurationSeconds(startedAt: number, finishedAt?: number | null, now = Date.now()) {
  return Math.max(0, ((finishedAt ?? now) - startedAt) / 1_000)
}

export interface AcquiredDataItem {
  label: string
  value: string
}

export function acquiredDataItems(server: Server | undefined, snapshot: Snapshot | undefined): AcquiredDataItem[] {
  if (!snapshot) return [{ label: '状态数据', value: '等待首次成功采集' }]
  const accelerator = acceleratorLabel(snapshot)
  const mainCpuProcesses = snapshot.cpuProcesses.filter((process) => process.isGroupLeader).length
  const syncText = !server?.remoteHistoryEnabled
    ? '未启用远端持续保存'
    : server.remoteHistoryLastSyncAt
      ? `已启用 · 最近同步 ${new Date(server.remoteHistoryLastSyncAt * 1_000).toLocaleString('zh-CN', { hour12: false })}`
      : '已启用 · 等待首次同步'
  return [
    { label: `${accelerator} 状态`, value: `${snapshot.gpus.length} 张 ${accelerator} · UTL、MEM、SM、温度、功率` },
    { label: '系统状态', value: 'CPU、内存、Swap、负载' },
    { label: '进程信息', value: `${snapshot.processes.length} 个 ${accelerator} 进程 · ${mainCpuProcesses} 个 CPU 主进程` },
    { label: '磁盘空间', value: `${snapshot.disks?.length ?? 0} 个有效磁盘` },
    { label: '远端历史', value: syncText },
  ]
}
