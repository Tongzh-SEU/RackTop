export const MINUTE_MS = 60 * 1000

export function minuteTickSplitNumber(timestamps: number[]): number {
  if (timestamps.length < 2) return 1
  const start = Math.min(...timestamps)
  const end = Math.max(...timestamps)
  return Math.max(1, Math.ceil((end - start) / MINUTE_MS))
}

export function formatFiveMinuteTimeLabel(value: number | string): string {
  const date = new Date(Number(value))
  if (!Number.isFinite(date.getTime()) || date.getSeconds() !== 0 || date.getMilliseconds() !== 0 || date.getMinutes() % 5 !== 0) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
