import { expect, it } from 'vitest'
import { aggregateTelemetryPreview } from './telemetryPreview'
import type { HistoryPoint } from '../types/models'

it('aggregates preview averages and extrema without counting unavailable fans as zero', () => {
  const points: HistoryPoint[] = [120, 450, 330].map((power, index) => ({ timestamp: index * 30, cpuUtilization: index * 30, memoryUtilization: 40, swapUtilization: 0, gpuUtilizations: { a: 20 }, gpuMemoryUtilizations: { a: 40 }, gpuPowerWatts: { a: power }, gpuFanSpeedsPercent: { a: [20, 70, null][index] } }))
  const [result] = aggregateTelemetryPreview(points, 600)
  expect(result.cpuUtilization).toBe(30)
  expect(result.gpuPowerWatts?.a).toBe(300)
  expect(result.gpuPowerMins?.a).toBe(120)
  expect(result.gpuPowerMaxes?.a).toBe(450)
  expect(result.gpuFanSpeedsPercent?.a).toBe(45)
  expect(result.gpuFanMins?.a).toBe(20)
  expect(result.gpuFanMaxes?.a).toBe(70)
})
