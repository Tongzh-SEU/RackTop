import { describe, expect, it } from 'vitest'
import { formatFiveMinuteTimeLabel, minuteTickSplitNumber } from './timeAxis'

describe('five-minute time axis labels', () => {
  it('shows only exact five-minute boundaries', () => {
    const boundary = new Date(2026, 7, 3, 17, 35, 0, 0).getTime()

    expect(formatFiveMinuteTimeLabel(boundary)).toBe('17:35')
    expect(formatFiveMinuteTimeLabel(boundary + 60_000)).toBe('')
    expect(formatFiveMinuteTimeLabel(boundary + 30_000)).toBe('')
  })

  it('asks the time scale for one tick per minute before filtering labels', () => {
    const start = new Date(2026, 7, 3, 17, 30).getTime()

    expect(minuteTickSplitNumber([start, start + 30 * 60_000])).toBe(30)
  })
})
