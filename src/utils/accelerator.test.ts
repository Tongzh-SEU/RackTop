import { describe, expect, it } from 'vitest'
import { acceleratorDeviceName, acceleratorDriverLabel, acceleratorLabel, acceleratorMemoryLabel } from './accelerator'

describe('accelerator presentation', () => {
  it.each([
    ['nvidia', 'GPU', 'GPU MEM', 'NVIDIA 驱动'],
    ['ascend', 'NPU', 'NPU MEM', 'NPU 驱动'],
    ['ppu', 'PPU', 'PPU MEM', 'PPU 驱动'],
  ] as const)('maps %s through the shared presentation helpers', (acceleratorVendor, label, memoryLabel, driverLabel) => {
    const snapshot = { acceleratorVendor }
    expect(acceleratorLabel(snapshot)).toBe(label)
    expect(acceleratorMemoryLabel(snapshot)).toBe(memoryLabel)
    expect(acceleratorDriverLabel(snapshot)).toBe(driverLabel)
  })

  it('keeps legacy snapshots compatible and only removes the NVIDIA brand prefix', () => {
    expect(acceleratorLabel({})).toBe('GPU')
    expect(acceleratorDeviceName('NVIDIA A100')).toBe('A100')
    expect(acceleratorDeviceName('Zhenwu PPU')).toBe('Zhenwu PPU')
  })
})
