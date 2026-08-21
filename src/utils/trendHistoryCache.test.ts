import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPoint } from '../types/models'
import { clearTrendHistoryCache, loadCachedTrendHistory } from './trendHistoryCache'

const points = [{ timestamp: 1 }] as HistoryPoint[]

describe('trend history cache', () => {
  beforeEach(() => {
    clearTrendHistoryCache()
    vi.useRealTimers()
  })

  it('shares one in-flight history request between accelerator cards', async () => {
    let resolve!: (value: HistoryPoint[]) => void
    const loader = vi.fn(() => new Promise<HistoryPoint[]>((done) => { resolve = done }))
    const first = loadCachedTrendHistory('server:3:0', loader)
    const second = loadCachedTrendHistory('server:3:0', loader)
    expect(loader).toHaveBeenCalledTimes(1)
    resolve(points)
    await expect(Promise.all([first, second])).resolves.toEqual([points, points])
  })

  it('reuses a recent result and refreshes it after expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const loader = vi.fn().mockResolvedValue(points)
    await loadCachedTrendHistory('server:3:0', loader, 25_000)
    await loadCachedTrendHistory('server:3:0', loader, 25_000)
    expect(loader).toHaveBeenCalledTimes(1)
    vi.setSystemTime(26_001)
    await loadCachedTrendHistory('server:3:0', loader, 25_000)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
