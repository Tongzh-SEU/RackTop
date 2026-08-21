import { describe, expect, it } from 'vitest'
import { DISK_STATUS_INTERVAL_MS, FOREGROUND_STATUS_INTERVAL_MS, shouldCollectDetailData, shouldIncludeProcesses, shouldRecordHistory, statusRefreshIntervalMs } from './refreshCadence'

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

  it('keeps disk scans on a fifteen-minute cadence', () => {
    expect(DISK_STATUS_INTERVAL_MS).toBe(15 * 60 * 1_000)
  })

  it('uses a lightweight first background sample before collecting detail data', () => {
    expect(shouldCollectDetailData(true, false)).toBe(false)
    expect(shouldCollectDetailData(true, true)).toBe(true)
    expect(shouldCollectDetailData(false, false)).toBe(true)
  })

  it('collects processes on the first startup sample even when the refresh is quiet', () => {
    expect(shouldIncludeProcesses(false, false, true, false, undefined, 10_000, 5)).toBe(true)
    expect(shouldIncludeProcesses(true, true, true, false, 9_000, 10_000, 5)).toBe(false)
    expect(shouldIncludeProcesses(true, true, true, false, 5_000, 10_000, 5)).toBe(true)
  })
})
