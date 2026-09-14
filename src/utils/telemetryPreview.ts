import type { HistoryPoint } from '../types/models'

export function aggregateTelemetryPreview(points: HistoryPoint[], bucketSeconds: number): HistoryPoint[] {
  const buckets = new Map<number, HistoryPoint[]>()
  for (const point of points) {
    const timestamp = Math.floor(point.timestamp / bucketSeconds) * bucketSeconds
    const bucket = buckets.get(timestamp) ?? []
    bucket.push(point)
    buckets.set(timestamp, bucket)
  }
  return Array.from(buckets, ([timestamp, samples]) => {
    const point: HistoryPoint = { ...samples[0], timestamp, isCompacted: true }
    for (const [valueKey, minKey, maxKey] of [['cpuUtilization', 'cpuMin', 'cpuMax'], ['memoryUtilization', 'memoryMin', 'memoryMax'], ['swapUtilization', 'swapMin', 'swapMax']] as const) {
      const values = samples.map(sample => sample[valueKey])
      point[valueKey] = values.reduce((sum, value) => sum + value, 0) / values.length
      point[minKey] = Math.min(...values)
      point[maxKey] = Math.max(...values)
    }
    for (const [valueKey, minKey, maxKey] of [
      ['gpuUtilizations', 'gpuMins', 'gpuMaxes'],
      ['gpuMemoryUtilizations', 'gpuMemoryMins', 'gpuMemoryMaxes'],
      ['gpuTemperaturesCelsius', 'gpuTemperatureMins', 'gpuTemperatureMaxes'],
      ['gpuPowerWatts', 'gpuPowerMins', 'gpuPowerMaxes'],
      ['gpuFanSpeedsPercent', 'gpuFanMins', 'gpuFanMaxes'],
    ] as const) {
      const grouped = new Map<string, number[]>()
      for (const sample of samples) for (const [uuid, value] of Object.entries(sample[valueKey] ?? {})) {
        if (value == null || !Number.isFinite(value)) continue
        const values = grouped.get(uuid) ?? []
        values.push(value)
        grouped.set(uuid, values)
      }
      point[valueKey] = Object.fromEntries(Array.from(grouped, ([uuid, values]) => [uuid, values.reduce((sum, value) => sum + value, 0) / values.length]))
      point[minKey] = Object.fromEntries(Array.from(grouped, ([uuid, values]) => [uuid, Math.min(...values)]))
      point[maxKey] = Object.fromEntries(Array.from(grouped, ([uuid, values]) => [uuid, Math.max(...values)]))
    }
    return point
  }).sort((left, right) => left.timestamp - right.timestamp)
}
