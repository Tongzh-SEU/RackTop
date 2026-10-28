import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { hasSystemMemoryWarning, systemMemoryPercent, systemMemoryThreshold } from './systemMemoryWarning'
const sample = (used: number, total = 1000) => ({system:{memoryUsedBytes:used,memoryTotalBytes:total}} as Snapshot)
describe('system memory threshold', () => {
  it('defaults to 90 and supports the full 80–100 interval', () => {
    expect(systemMemoryThreshold(undefined)).toBe(90)
    for (const threshold of [80,90,100]) {
      expect(hasSystemMemoryWarning(sample(threshold*10),threshold)).toBe(false)
      if(threshold<100) expect(hasSystemMemoryWarning(sample(threshold*10+1),threshold)).toBe(true)
    }
  })
  it('does not infer recovery or alarms from invalid memory values', () => {
    for (const s of [sample(1,0),sample(-1),sample(NaN),sample(1001)]) {
      expect(systemMemoryPercent(s)).toBeNull()
      expect(hasSystemMemoryWarning(s,90)).toBe(false)
    }
  })
})
