import { describe, expect, it } from 'vitest'
import { FOREGROUND_STATUS_INTERVAL_MS, shouldRecordHistory, statusRefreshIntervalMs } from './refreshCadence'

describe('refresh cadence', () => {
  it('refreshes the two fast status views every half second without changing the history cadence', () => {
    expect(statusRefreshIntervalMs(true, false, 10, 30)).toBe(FOREGROUND_STATUS_INTERVAL_MS)
    expect(shouldRecordHistory(10_000, 11_000, 10)).toBe(false)
    expect(shouldRecordHistory(10_000, 20_000, 10)).toBe(true)
  })

  it('keeps the normal sampling cadence outside the two fast status views', () => {
    expect(statusRefreshIntervalMs(false, false, 10, 30)).toBe(10_000)
  })

  it('uses the slower configured cadence while the app is hidden', () => {
    expect(statusRefreshIntervalMs(true, true, 10, 30)).toBe(30_000)
    expect(statusRefreshIntervalMs(true, true, 60, 30)).toBe(60_000)
  })

  it('records the first successful snapshot', () => {
    expect(shouldRecordHistory(undefined, 10_000, 10)).toBe(true)
  })
})
