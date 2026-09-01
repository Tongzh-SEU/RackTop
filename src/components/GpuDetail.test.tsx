// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GpuDetail } from '../App'
import type { Snapshot } from '../types/models'

vi.mock('./ResourceTrend', () => ({ ResourceTrend: () => null }))
vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'gpu-box', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp: 1_800_000_000, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 25, currentUserCpuUtilization: 10, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 40, memoryTotalBytes: 100, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [0, 1, 2].map((index) => ({
    index,
    uuid: `GPU-${index}`,
    name: 'NVIDIA A100',
    utilization: 55,
    memoryUtilization: 20,
    memoryUsedMb: 1024,
    memoryTotalMb: 40_960,
    temperatureCelsius: 42,
    powerWatts: 90,
    powerLimitWatts: 250,
    smClockMhz: 1410,
    memoryClockMhz: 1215,
    performanceState: 'P0',
    fanSpeedPercent: null,
    throttleReason: '正常',
    eccErrors: null,
  })),
  processes: [], cpuProcesses: [],
}

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('GpuDetail hardware disclosure', () => {
  it('expands a card in a three-column set when optional hardware values are null', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<GpuDetail snapshot={snapshot} points={[]} selectedGpuUuid={null} onSelectGpu={vi.fn()} animateChart={false} />)
    })

    expect(container.querySelectorAll('.gpu-detail')).toHaveLength(3)
    const toggles = container.querySelectorAll<HTMLButtonElement>('.gpu-detail__hardware-toggle')
    expect(toggles).toHaveLength(3)
    expect(toggles[0].getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggles[0].click())

    expect(toggles[0].getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('功率上限')
    expect(container.textContent).not.toContain('风扇')
    expect(container.textContent).not.toContain('ECC 错误')
  })
})
