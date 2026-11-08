import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { deriveSystemMemoryWarnings, hasSystemMemoryWarning, systemMemoryPercent, systemMemoryThreshold } from './systemMemoryWarning'
const sample = (used: number, total = 1000) => ({system:{memoryUsedBytes:used,memoryTotalBytes:total}} as Snapshot)
describe('system memory threshold', () => {
  it('derives only active server warnings using the configured threshold and ignore state', () => {
    const servers = ['high', 'ignored', 'boundary', 'invalid', 'missing'].map((id) => ({ id, name: id } as Server))
    const snapshots = { high: sample(960), ignored: sample(990), boundary: sample(950), invalid: sample(NaN), removed: sample(990) }
    const warnings = deriveSystemMemoryWarnings(servers, snapshots, 95, new Set(['ignored']))
    expect(warnings).toEqual([{ serverId: 'high', serverName: 'high', memoryUsedBytes: 960, memoryTotalBytes: 1000, percent: 96, threshold: 95 }])
    expect(deriveSystemMemoryWarnings(servers, snapshots, 100, new Set())).toEqual([])
  })
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
