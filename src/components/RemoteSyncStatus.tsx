import { AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import type { Server } from '../types/models'

export const REMOTE_SYNC_STALE_SECONDS = 10 * 60
export const REMOTE_SYNC_FEEDBACK_DELAY_MS = 800
export const REMOTE_SYNC_SUCCESS_DURATION_MS = 2_000

export interface RemoteSyncStatusState {
  phase: 'syncing' | 'success' | 'error'
  completed: number
  total: number
  importedCount: number
  failedServerIds: string[]
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
  return !alreadyQueued && status?.phase === 'error' && status.failedServerIds.includes(serverId)
}

export function RemoteSyncStatus({ status, onOpenFailure }: { status: RemoteSyncStatusState; onOpenFailure: () => void }) {
  if (status.phase === 'syncing') {
    return <span className="remote-sync-status remote-sync-status--syncing" role="status" aria-live="polite"><RefreshCw className="spin" size={13} />正在同步历史数据 · {status.completed}/{status.total} 台</span>
  }
  if (status.phase === 'success') {
    return <span className="remote-sync-status remote-sync-status--success" role="status" aria-live="polite"><CheckCircle2 size={13} />历史已同步 · 新增 {status.importedCount.toLocaleString('zh-CN')} 条</span>
  }
  return <button type="button" className="remote-sync-status remote-sync-status--error" onClick={onOpenFailure}><AlertCircle size={13} />{status.failedServerIds.length} 台历史同步失败 · 5 分钟后重试</button>
}
