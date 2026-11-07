import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isRemoteHistoryCleanupPendingError, isRemoteHistoryRetryableError, isRemoteHistoryStartingError, isRemoteSyncFresh, RemoteSyncCoordinator, RemoteSyncStatus, REMOTE_SYNC_STALE_SECONDS, shouldRetryRemoteSyncAfterRecovery, shouldShowRemoteSyncImmediately, type RemoteSyncStatusState } from './RemoteSyncStatus'

const baseStatus: RemoteSyncStatusState = { phase: 'syncing', completed: 2, total: 4, importedCount: 0, failedServerIds: [] }

describe('RemoteSyncStatus', () => {
  it('shows startup feedback immediately only when remote history is stale', () => {
    const now = 10_000
    expect(isRemoteSyncFresh({ remoteHistoryLastSyncAt: now - REMOTE_SYNC_STALE_SECONDS }, now)).toBe(true)
    expect(isRemoteSyncFresh({ remoteHistoryLastSyncAt: now - REMOTE_SYNC_STALE_SECONDS - 1 }, now)).toBe(false)
    expect(shouldShowRemoteSyncImmediately([{ remoteHistoryLastSyncAt: null }], now)).toBe(true)
    expect(shouldShowRemoteSyncImmediately([{ remoteHistoryLastSyncAt: now - REMOTE_SYNC_STALE_SECONDS - 1 }], now)).toBe(true)
    expect(shouldShowRemoteSyncImmediately([{ remoteHistoryLastSyncAt: now - REMOTE_SYNC_STALE_SECONDS }], now)).toBe(false)
  })

  it('renders quiet progress, success, and actionable failure states', () => {
    const syncing = renderToStaticMarkup(<RemoteSyncStatus status={baseStatus} onOpenFailure={() => {}} />)
    expect(syncing).toContain('class="lucide lucide-refresh-cw spin"')
    expect(syncing).toContain('正在同步历史数据 · 2/4 台')
    expect(renderToStaticMarkup(<RemoteSyncStatus status={{ ...baseStatus, phase: 'success', importedCount: 1_240 }} onOpenFailure={() => {}} />)).toContain('历史已同步 · 新增 1,240 条')
    const failure = renderToStaticMarkup(<RemoteSyncStatus status={{ ...baseStatus, phase: 'error', failedServerIds: ['a', 'b'] }} onOpenFailure={() => {}} />)
    expect(failure).toContain('<button')
    expect(failure).toContain('2 台历史同步失败 · 5 分钟后重试')
    const starting = renderToStaticMarkup(<RemoteSyncStatus status={{ ...baseStatus, phase: 'starting', startingServerIds: ['a'], retryDelaySeconds: 15 }} onOpenFailure={() => {}} />)
    expect(starting).toBe('')
    const cleanupPending = renderToStaticMarkup(<RemoteSyncStatus status={{ ...baseStatus, phase: 'cleanupPending', cleanupPendingServerIds: ['a'] }} onOpenFailure={() => {}} />)
    expect(cleanupPending).toBe('')
  })

  it('recognizes startup-in-progress and allows one retry after the server recovers', () => {
    const startingError = '远端历史 daemon 正在启动，请稍后重试'
    expect(isRemoteHistoryStartingError(startingError)).toBe(true)
    expect(isRemoteHistoryRetryableError('连接 GPU 节点同步历史超时')).toBe(true)
    expect(isRemoteHistoryRetryableError('SSH 连接失败：Connection refused')).toBe(true)
    expect(isRemoteHistoryRetryableError('SSH 主机指纹验证失败：Host key verification failed')).toBe(false)
    const cleanupPendingError = '旧版远端历史进程正在退出，等待清理完成后重试'
    expect(isRemoteHistoryCleanupPendingError(cleanupPendingError)).toBe(true)
    expect(isRemoteHistoryStartingError('Permission denied')).toBe(false)
    expect(isRemoteHistoryCleanupPendingError('Permission denied')).toBe(false)
    const startingStatus: RemoteSyncStatusState = { ...baseStatus, phase: 'starting', startingServerIds: ['server-a'], failedServerIds: [] }
    expect(shouldRetryRemoteSyncAfterRecovery(startingStatus, 'server-a', false)).toBe(true)
    expect(shouldRetryRemoteSyncAfterRecovery(startingStatus, 'server-a', true)).toBe(false)
    const cleanupPendingStatus: RemoteSyncStatusState = { ...baseStatus, phase: 'cleanupPending', cleanupPendingServerIds: ['server-a'], failedServerIds: [] }
    expect(shouldRetryRemoteSyncAfterRecovery(cleanupPendingStatus, 'server-a', false)).toBe(true)
    expect(shouldRetryRemoteSyncAfterRecovery(cleanupPendingStatus, 'server-a', true)).toBe(false)
  })

  it('retries a failed remote sync once when that server recovers', () => {
    const errorStatus: RemoteSyncStatusState = { ...baseStatus, phase: 'error', failedServerIds: ['server-a'] }
    expect(shouldRetryRemoteSyncAfterRecovery(errorStatus, 'server-a', false)).toBe(true)
    expect(shouldRetryRemoteSyncAfterRecovery(errorStatus, 'server-a', true)).toBe(false)
    expect(shouldRetryRemoteSyncAfterRecovery(errorStatus, 'server-b', false)).toBe(false)
    expect(shouldRetryRemoteSyncAfterRecovery({ ...errorStatus, phase: 'success' }, 'server-a', false)).toBe(false)
  })

  it('serializes replacement sync runs instead of leaving overlapping progress behind', async () => {
    const coordinator = new RemoteSyncCoordinator()
    const events: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const first = coordinator.run(async () => {
      events.push('first:start')
      markFirstStarted()
      await firstGate
      events.push('first:end')
    })
    await firstStarted
    const second = coordinator.run(async () => { events.push('second') })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })
})
