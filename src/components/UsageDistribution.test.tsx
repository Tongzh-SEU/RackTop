import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot, UsageDistribution as UsageDistributionData } from '../types/models'
import { UsageDistribution } from './UsageDistribution'

const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'gpu-box', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 1, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [{ index: 0, uuid: 'GPU-0', name: 'NVIDIA A100', utilization: 0, memoryUtilization: 0, memoryUsedMb: 0, memoryTotalMb: 100, temperatureCelsius: 30, powerWatts: 40 }],
  processes: [], cpuProcesses: [],
}

const distribution: UsageDistributionData = {
  users: [{ username: 'alice', activeSeconds: 60_000, memoryMbSeconds: 3_000_000 }, { username: 'bob', activeSeconds: 60, memoryMbSeconds: 3_000 }],
  coveredDays: 2,
  requestedDays: 30,
  coverageGpuSeconds: 172_800,
}

describe('UsageDistribution', () => {
  it('renders two complete 38 by 5 waffle grids with strong user colors', () => {
    const markup = renderToStaticMarkup(<UsageDistribution snapshot={snapshot} data={distribution} />)

    expect(markup.match(/title="[^"]+ [\d.]+%"/g)).toHaveLength(380)
    expect(markup.match(/data-columns="38" data-rows="5"/g)).toHaveLength(2)
    expect(markup).toContain('使用时间百分比分布')
    expect(markup).toContain('显存占用百分比分布')
    expect(markup).toContain('color-mix(in srgb, #4f8ee8 92%, var(--surface))')
    expect(markup).toContain('background:var(--surface-muted)')
    expect(markup).toContain('缺失')
    expect(markup).not.toContain('usage-coverage')
    expect(markup).toContain('按已覆盖 2 天统计')
    expect(markup).toContain('alice 34.7%')
    expect(markup).toContain('data-partial="true"')
    expect(markup).toContain('color-mix(in srgb, #5aa779 46%, var(--surface))')
  })
})
