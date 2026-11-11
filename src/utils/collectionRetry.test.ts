import { describe, expect, it } from 'vitest'
import { collectionRetryDelayMs, collectionRetryRemainingMs } from './collectionRetry'

describe('collection retry delay', () => {
  it('preserves backoff floors and bounds the jitter', () => {
    for (const [failure, minimum] of [[1, 1000], [2, 2000], [3, 5000], [4, 10000], [5, 30000], [100, 30000]]) {
      expect(collectionRetryDelayMs(failure, () => 0)).toBe(minimum)
      expect(collectionRetryDelayMs(failure, () => 0.9999)).toBe(minimum + 999)
    }
  })

  it('spreads identical failures and keeps an existing deadline fixed', () => {
    const early = 10000 + collectionRetryDelayMs(2, () => 0.1)
    const late = 10000 + collectionRetryDelayMs(2, () => 0.9)
    expect(late - early).toBe(800)
    expect(collectionRetryRemainingMs(early, 12000)).toBe(100)
    expect(collectionRetryRemainingMs(early, early)).toBe(0)
    expect(collectionRetryRemainingMs(early, early + 1000)).toBe(0)
    expect(collectionRetryRemainingMs(undefined, 12000)).toBe(0)
  })
})
