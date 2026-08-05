import type { Snapshot } from '../types/models'

type NvidiaState = Snapshot['nvidiaSmi']

export const IGNORED_NVIDIA_WARNINGS_STORAGE_KEY = 'racktop.ignoredNvidiaWarnings.v1'

export function parseIgnoredNvidiaWarningIds(serialized: string | null): Set<string> {
  if (!serialized) return new Set()
  try {
    const value = JSON.parse(serialized)
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [])
  } catch {
    return new Set()
  }
}

export function loadIgnoredNvidiaWarningIds(): Set<string> {
  return typeof localStorage === 'undefined' ? new Set() : parseIgnoredNvidiaWarningIds(localStorage.getItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY))
}

export function saveIgnoredNvidiaWarningIds(ids: Set<string>) {
  if (typeof localStorage !== 'undefined') localStorage.setItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY, JSON.stringify([...ids]))
}

export function displayedNvidiaServerStatus(snapshot: Snapshot, ignored: boolean): Snapshot['status'] {
  return ignored && snapshot.nvidiaSmi !== 'available' ? 'online' : snapshot.status
}

export function nvidiaIssueTitle(state: NvidiaState) {
  if (state === 'degraded') return '部分 NVIDIA GPU 无法监控'
  if (state === 'permissionDenied') return '没有 NVIDIA GPU 监控权限'
  if (state === 'missing') return '未检测到 NVIDIA 监控工具'
  return 'NVIDIA GPU 监控异常'
}

export function nvidiaIssueGuidance(state: NvidiaState) {
  if (state === 'degraded') return '其余可访问 GPU 会继续监控。请检查异常卡的 PCIe、供电和内核 Xid 日志，不建议直接重装驱动。'
  if (state === 'permissionDenied') return '请检查当前 SSH 用户执行 nvidia-smi 的权限。'
  if (state === 'missing') return '服务器上未检测到可执行的 nvidia-smi。CPU 与内存监控仍会继续。'
  return 'nvidia-smi 已安装但执行失败，请先检查驱动日志和服务器状态。'
}

export function canOfferNvidiaDriverInstall(state: NvidiaState) {
  return state === 'missing'
}
