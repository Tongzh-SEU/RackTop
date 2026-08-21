import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPoint } from '../types/models'
import { clearTrendHistoryCache, getCachedTrendHistory, loadCachedTrendHistory } from './trendHistoryCache'

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

  it('keeps an expired result available for immediate stale-while-refresh rendering', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    await loadCachedTrendHistory('server:3:0', vi.fn().mockResolvedValue(points), 25_000)
    vi.setSystemTime(90_000)

    expect(getCachedTrendHistory('server:3:0')).toBe(points)
  })
})
