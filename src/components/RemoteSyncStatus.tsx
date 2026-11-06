import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import type { Server } from '../types/models'

export const REMOTE_SYNC_STALE_SECONDS = 10 * 60
export const REMOTE_SYNC_FEEDBACK_DELAY_MS = 800
export const REMOTE_SYNC_SUCCESS_DURATION_MS = 2_000
export const REMOTE_SYNC_CLEANUP_RETRY_INITIAL_MS = 15_000
export const REMOTE_SYNC_RETRY_MAX_MS = 5 * 60_000

export interface RemoteSyncStatusState {
  phase: 'syncing' | 'starting' | 'cleanupPending' | 'success' | 'error'
  completed: number
  total: number
  importedCount: number
  failedServerIds: string[]
  failedServerErrors?: Record<string, string>
  startingServerIds?: string[]
  cleanupPendingServerIds?: string[]
  retryDelaySeconds?: number
}

export class RemoteSyncCoordinator {
  private active: Promise<void> | null = null

  async run(task: () => Promise<void>) {
    while (this.active) {
      await this.active.catch(() => undefined)
    }
    const active = Promise.resolve().then(task)
    this.active = active
    try {
      await active
    } finally {
      if (this.active === active) this.active = null
    }
  }
}

export function isRemoteSyncFresh(server: Pick<Server, 'remoteHistoryLastSyncAt'>, nowSeconds: number): boolean {
  return Boolean(server.remoteHistoryLastSyncAt && nowSeconds - server.remoteHistoryLastSyncAt <= REMOTE_SYNC_STALE_SECONDS)
}

export function shouldShowRemoteSyncImmediately(servers: Array<Pick<Server, 'remoteHistoryLastSyncAt'>>, nowSeconds: number): boolean {
  return servers.some((server) => !isRemoteSyncFresh(server, nowSeconds))
}

export function shouldRetryRemoteSyncAfterRecovery(status: RemoteSyncStatusState | null, serverId: string, alreadyQueued: boolean) {
  return !alreadyQueued && Boolean(status && (
    (status.phase === 'error' && status.failedServerIds.includes(serverId)) ||
    (status.phase === 'starting' && status.startingServerIds?.includes(serverId)) ||
    (status.phase === 'cleanupPending' && status.cleanupPendingServerIds?.includes(serverId)) ||
    status.cleanupPendingServerIds?.includes(serverId)
  ))
}

export function isRemoteHistoryStartingError(error: unknown) {
  return String(error).includes('远端历史 daemon 正在启动')
}

export function isRemoteHistoryCleanupPendingError(error: unknown) {
  return String(error).includes('旧版远端历史进程正在退出')
}

function retryDelayLabel(seconds = 5 * 60) {
  return seconds < 60 ? `${seconds} 秒后重试` : `${Math.ceil(seconds / 60)} 分钟后重试`
}

export function RemoteSyncStatus({ status, onOpenFailure }: { status: RemoteSyncStatusState; onOpenFailure: () => void }) {
  if (status.phase === 'syncing') {
    return <span className="remote-sync-status remote-sync-status--syncing" role="status" aria-live="polite"><RefreshCw className="spin" size={13} />正在同步历史数据 · {status.completed}/{status.total} 台</span>
  }
  if (status.phase === 'starting') {
    return <span className="remote-sync-status remote-sync-status--syncing" role="status" aria-live="polite">远端 daemon 启动中 · {status.startingServerIds?.length ?? 1} 台，5 分钟后重试</span>
  }
  if (status.phase === 'cleanupPending') {
    return <span className="remote-sync-status remote-sync-status--syncing" role="status" aria-live="polite">旧版远端进程退出中 · {status.cleanupPendingServerIds?.length ?? 1} 台，{retryDelayLabel(status.retryDelaySeconds)}</span>
  }
  if (status.phase === 'success') {
    return <span className="remote-sync-status remote-sync-status--success" role="status" aria-live="polite"><CheckCircle2 size={13} />历史已同步 · 新增 {status.importedCount.toLocaleString('zh-CN')} 条</span>
  }
  const cleanupPendingCount = status.cleanupPendingServerIds?.length ?? 0
  const message = cleanupPendingCount > 0
    ? `旧版远端进程退出中 · ${cleanupPendingCount} 台；${status.failedServerIds.length} 台同步失败，${retryDelayLabel(status.retryDelaySeconds)}`
    : `${status.failedServerIds.length} 台历史同步失败 · 5 分钟后重试`
  return <button type="button" className="remote-sync-status remote-sync-status--error" onClick={onOpenFailure}><AlertCircle size={13} />{message}</button>
}
