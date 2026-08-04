export const FOREGROUND_STATUS_INTERVAL_MS = 500

export function statusRefreshIntervalMs(fastStatusView: boolean, documentHidden: boolean, samplingIntervalSeconds: number, backgroundIntervalSeconds: number): number {
  if (documentHidden) return Math.max(samplingIntervalSeconds, backgroundIntervalSeconds) * 1_000
  return (fastStatusView ? FOREGROUND_STATUS_INTERVAL_MS : Math.max(1, samplingIntervalSeconds) * 1_000)
}

export function shouldRecordHistory(lastRecordedAtMs: number | undefined, nowMs: number, samplingIntervalSeconds: number): boolean {
  if (lastRecordedAtMs === undefined) return true
  return nowMs - lastRecordedAtMs >= Math.max(1, samplingIntervalSeconds) * 1_000
}
