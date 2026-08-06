import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RemoteSyncStatus, REMOTE_SYNC_STALE_SECONDS, shouldRetryRemoteSyncAfterRecovery, shouldShowRemoteSyncImmediately, type RemoteSyncStatusState } from './RemoteSyncStatus'

const baseStatus: RemoteSyncStatusState = { phase: 'syncing', completed: 2, total: 4, importedCount: 0, failedServerIds: [] }

describe('RemoteSyncStatus', () => {
  it('shows startup feedback immediately only when remote history is stale', () => {
    const now = 10_000
    expect(shouldShowRemoteSyncImmediately([{ remoteHistoryLastSyncAt: null }], now)).toBe(true)
    expect(shouldShowRemoteSyncImmediately([{ remoteHistoryLastSyncAt: now - REMOTE_SYNC_STALE_SECONDS - 1 }], now)).toBe(true)
    expect(shouldShowRemoteSyncImmediately([{ remoteHistoryLastSyncAt: now - REMOTE_SYNC_STALE_SECONDS }], now)).toBe(false)
  })

  it('renders quiet progress, success, and actionable failure states', () => {
    expect(renderToStaticMarkup(<RemoteSyncStatus status={baseStatus} onOpenFailure={() => {}} />)).toContain('正在同步历史数据 · 2/4 台')
    expect(renderToStaticMarkup(<RemoteSyncStatus status={{ ...baseStatus, phase: 'success', importedCount: 1_240 }} onOpenFailure={() => {}} />)).toContain('历史已同步 · 新增 1,240 条')
    const failure = renderToStaticMarkup(<RemoteSyncStatus status={{ ...baseStatus, phase: 'error', failedServerIds: ['a', 'b'] }} onOpenFailure={() => {}} />)
    expect(failure).toContain('<button')
    expect(failure).toContain('2 台同步失败 · 5 分钟后重试')
  })

  it('retries a failed remote sync once when that server recovers', () => {
    const errorStatus: RemoteSyncStatusState = { ...baseStatus, phase: 'error', failedServerIds: ['server-a'] }
    expect(shouldRetryRemoteSyncAfterRecovery(errorStatus, 'server-a', false)).toBe(true)
    expect(shouldRetryRemoteSyncAfterRecovery(errorStatus, 'server-a', true)).toBe(false)
    expect(shouldRetryRemoteSyncAfterRecovery(errorStatus, 'server-b', false)).toBe(false)
    expect(shouldRetryRemoteSyncAfterRecovery({ ...errorStatus, phase: 'success' }, 'server-a', false)).toBe(false)
  })
})
