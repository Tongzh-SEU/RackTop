const RETRY_SECONDS = [1, 2, 5, 10, 30] as const

// Preserve the existing minimum delays; add up to one second of jitter so
// clients recovering from the same outage do not all reconnect on the same tick.
export function collectionRetryDelayMs(failureCount: number, random = Math.random): number {
  const index = Math.min(Math.max(Math.floor(failureCount) - 1, 0), RETRY_SECONDS.length - 1)
  return RETRY_SECONDS[index] * 1000 + Math.floor(random() * 1000)
}

export function collectionRetryRemainingMs(retryAt: number | undefined, now: number): number {
  return Math.max(0, (retryAt ?? 0) - now)
}
