import { describe, expect, it } from 'vitest'
import { acquiredDataItems, interactionDurationSeconds, interactionVisualStatus } from './activityLog'
import type { Server, Snapshot } from '../types/models'

describe('interaction log presentation', () => {
  it('keeps short running work neutral and only turns blue after one second', () => {
    expect(interactionVisualStatus('running', 10_000, 10_999)).toBe('normal')
    expect(interactionVisualStatus('running', 10_000, 11_000)).toBe('running')
    expect(interactionVisualStatus('success', 10_000, 20_000)).toBe('normal')
    expect(interactionVisualStatus('error', 10_000, 10_001)).toBe('error')
    expect(interactionDurationSeconds(10_000, 10_420)).toBeCloseTo(0.42)
  })

  it('describes the latest snapshot without retaining another history log', () => {
    const snapshot = { gpus: [{}, {}], processes: [{}, {}, {}], cpuProcesses: [{ isGroupLeader: true }, { isGroupLeader: false }], disks: [{}, {}, {}] } as Snapshot
    const server = { remoteHistoryEnabled: false } as Server
    const items = acquiredDataItems(server, snapshot)
    expect(items.find((item) => item.label === 'GPU 状态')?.value).toContain('2 张 GPU')
    expect(items.find((item) => item.label === '进程信息')?.value).toBe('3 个 GPU 进程 · 1 个 CPU 主进程')
    expect(items.find((item) => item.label === '磁盘空间')?.value).toBe('3 个有效磁盘')
    expect(items.find((item) => item.label === '远端历史')?.value).toBe('未启用远端持续保存')
  })

  it('uses the shared PPU terminology in collection logs', () => {
    const snapshot = { acceleratorVendor: 'ppu', gpus: [{}, {}], processes: [{}], cpuProcesses: [], disks: [] } as unknown as Snapshot
    const items = acquiredDataItems(undefined, snapshot)
    expect(items.find((item) => item.label === 'PPU 状态')?.value).toContain('2 张 PPU')
    expect(items.find((item) => item.label === '进程信息')?.value).toBe('1 个 PPU 进程 · 0 个 CPU 主进程')
  })
})
