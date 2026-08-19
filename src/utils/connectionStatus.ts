import type { ServerStatus } from '../types/models'

export const OFFLINE_FAILURE_THRESHOLD = 3

export function serverStatusAfterFailure(failureCount: number): ServerStatus {
  return failureCount >= OFFLINE_FAILURE_THRESHOLD ? 'offline' : 'connecting'
}

export function shouldShowConnectingOnAttempt(quiet: boolean, hasSnapshot: boolean, failureCount: number) {
  return !quiet || !hasSnapshot || (failureCount > 0 && failureCount < OFFLINE_FAILURE_THRESHOLD)
}

export function canDisplayServerDetails(status: ServerStatus) {
  return status === 'online' || status === 'warning'
}
