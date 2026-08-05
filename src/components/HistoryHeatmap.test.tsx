import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HistoryHeatmapPoint, Snapshot } from '../types/models'
import { HistoryHeatmaps, StorageWaffleList, historyHeatmapTone } from './HistoryHeatmap'

const timestamp = new Date(2026, 7, 4, 6).getTime() / 1000
const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'gpu-box', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 25, currentUserCpuUtilization: 10, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 40, memoryTotalBytes: 100, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [
    { index: 0, uuid: 'GPU-0', name: 'NVIDIA A100', utilization: 55, memoryUtilization: 70, memoryUsedMb: 70, memoryTotalMb: 100, temperatureCelsius: 40, powerWatts: 100 },
    { index: 1, uuid: 'GPU-1', name: 'NVIDIA A100', utilization: 10, memoryUtilization: 20, memoryUsedMb: 20, memoryTotalMb: 100, temperatureCelsius: 38, powerWatts: 90 },
  ],
  disks: [{ mountPoint: '/data', usedBytes: 4 * 1024 ** 3, totalBytes: 10 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, currentUserUsedBytes: 1.5 * 1024 ** 3 }],
  processes: [], cpuProcesses: [],
}
const points: HistoryHeatmapPoint[] = [{ timestamp, sampleCount: 12, cpuUtilization: 25, memoryUtilization: 40, gpuUtilizations: { 'GPU-0': 55, 'GPU-1': 10 }, gpuMemoryUtilizations: { 'GPU-0': 70, 'GPU-1': 20 } }]

describe('HistoryHeatmaps', () => {
  it('renders one CPU block and one block per GPU', () => {
    const markup = renderToStaticMarkup(<HistoryHeatmaps snapshot={snapshot} points={points} retentionDays={2} />)
    expect(markup.match(/<section class="panel history-heatmap/g)).toHaveLength(3)
    expect(markup).toContain('CPU')
    expect(markup).toContain('GPU 0')
    expect(markup).toContain('GPU 1')
  })

  it('defaults CPU and every GPU to MEM', () => {
    const markup = renderToStaticMarkup(<HistoryHeatmaps snapshot={snapshot} points={points} retentionDays={2} />)
    expect(markup).toContain('CPU MEM 每 3 小时平均值热力图')
    expect(markup).toContain('GPU 0 MEM 每 3 小时平均值热力图')
    expect(markup).toContain('GPU 1 MEM 每 3 小时平均值热力图')
  })

  it('uses a full-width responsive grid while preserving minimum cell size', () => {
    const markup = renderToStaticMarkup(<HistoryHeatmaps snapshot={snapshot} points={points} retentionDays={30} />)
    expect(markup).toContain('data-columns="30" data-rows="8"')
    expect(markup).toContain('repeat(30, minmax(var(--heat-cell-size), 1fr))')
  })

  it('swaps UTL and MEM colors for CPU and GPU heatmaps', () => {
    expect(historyHeatmapTone('utilization', 'blue')).toBe('purple')
    expect(historyHeatmapTone('memory', 'blue')).toBe('blue')
    expect(historyHeatmapTone('utilization', 'green')).toBe('purple')
    expect(historyHeatmapTone('memory', 'green')).toBe('green')
  })

  it('renders storage as one full-width 100 by 5 ownership waffle per disk', () => {
    const markup = renderToStaticMarkup(<StorageWaffleList disks={snapshot.disks ?? []} />)
    expect(markup).toContain('存储空间')
    expect(markup).toContain('data-columns="100" data-rows="5"')
    expect(markup).toContain('/data')
    expect(markup).toContain('你的 <strong>1.5 GB</strong>')
    expect(markup).toContain('其他 <strong>2.5 GB</strong>')
    expect(markup).toContain('总计 <strong>10.0 GB</strong>')
    expect(markup.match(/class="storage-waffle-grid"/g)).toHaveLength(1)
    expect(markup.match(/data-storage-cell="true"/g)).toHaveLength(500)
    expect(markup).toContain('class="is-own"')
    expect(markup).toContain('class="is-other"')
  })
})
