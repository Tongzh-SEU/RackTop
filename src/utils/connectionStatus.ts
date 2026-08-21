import type { ServerStatus } from '../types/models'

export const OFFLINE_FAILURE_THRESHOLD = 3
export const ACTIVE_SYNC_OFFLINE_FAILURE_THRESHOLD = 6

export function offlineFailureThreshold(activeProjectSync: boolean) {
  return activeProjectSync ? ACTIVE_SYNC_OFFLINE_FAILURE_THRESHOLD : OFFLINE_FAILURE_THRESHOLD
}

export function serverStatusAfterFailure(failureCount: number): ServerStatus {
  return failureCount >= OFFLINE_FAILURE_THRESHOLD ? 'offline' : 'connecting'
}

export function serverStatusAfterSyncAwareFailure(currentStatus: ServerStatus, failureCount: number, activeProjectSync: boolean, hasSnapshot: boolean): ServerStatus {
  if (activeProjectSync && hasSnapshot && failureCount < ACTIVE_SYNC_OFFLINE_FAILURE_THRESHOLD && (currentStatus === 'online' || currentStatus === 'warning')) return currentStatus
  return failureCount >= offlineFailureThreshold(activeProjectSync) ? 'offline' : 'connecting'
}

export function shouldShowConnectingOnAttempt(quiet: boolean, hasSnapshot: boolean, failureCount: number) {
  return !quiet || !hasSnapshot || (failureCount > 0 && failureCount < OFFLINE_FAILURE_THRESHOLD)
}

export function canDisplayServerDetails(status: ServerStatus) {
  return status === 'online' || status === 'warning'
}
