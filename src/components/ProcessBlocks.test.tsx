// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { ProcessBlocks } from './ProcessBlocks'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'gpu-box', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [],
  processes: [{ gpuUuid: 'gpu-0', gpuIndex: 0, pid: 21_312, parentPid: 1, username: 'tongzh', command: 'python train.py', memoryUsedMb: 1024, smUtilization: 73, cpuPercent: 20, elapsed: '01:00', isCurrentUser: true, isGroupLeader: true }],
  cpuProcesses: [{ pid: 2_212, parentPid: 21_312, username: 'tongzh', command: 'python worker.py', cpuPercent: 10, memoryPercent: 1, memoryUsedBytes: 1024, elapsed: '00:30', isCurrentUser: true, isGroupLeader: false }],
}

describe('ProcessBlocks', () => {
  it('uses NPU labels without changing the shared process rendering', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={{ ...snapshot, acceleratorVendor: 'ascend' }} compact currentLabels />)
    expect(markup).toContain('当前 NPU 进程')
    expect(markup).toContain('<th>NPU</th><th>PID</th>')
    expect(markup).toContain('NPU 0')
    expect(markup).not.toContain('当前 GPU 进程')
  })

  it('renders the CPU block below the GPU block with matching task markers', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={snapshot} compact currentLabels onRequestTerminate={() => {}} />)
    expect(markup).toContain('当前 GPU 进程')
    expect(markup).toContain('当前 CPU 进程')
    expect(markup.indexOf('GPU 进程')).toBeLessThan(markup.indexOf('CPU 进程'))
    expect(markup).toContain('<th>GPU</th><th>PID</th>')
    expect(markup).not.toContain('<th>GPU · PID</th>')
    expect(markup).toContain('<th>用户</th>')
    expect(markup.match(/<th>运行时间<\/th>/g)).toHaveLength(2)
    expect(markup).toContain('01:00')
    expect(markup).toContain('00:30')
    expect(markup).toContain('tongzh')
    expect(markup).not.toContain('<th>任务</th>')
    expect(markup.match(/aria-label="PID (?:21312|2212)，任务根 PID 21312"/g)).toHaveLength(2)
    expect(markup).toContain('process-task-marker')
  })

  it('offers a direct termination action for every current-user process', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={snapshot} onRequestTerminate={() => {}} />)
    expect(markup).not.toContain('type="checkbox"')
    expect(markup).toContain('aria-label="结束 PID 21312"')
    expect(markup).toContain('aria-label="结束 PID 2212"')
    expect(markup).toContain('lucide-circle-x')
  })

  it('shows a red spinner while termination is running', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={snapshot} terminatingPid={21_312} onRequestTerminate={() => {}} />)
    expect(markup).toContain('aria-label="正在结束 PID 21312"')
    expect(markup).toContain('process-terminate-button is-terminating')
    expect(markup).toContain('class="lucide lucide-loader-circle spin"')
    expect(markup).toContain('process-block__terminating')
    expect(markup).toContain('正在结束 PID 21312')
  })

  it('hides empty process kinds when requested', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={{ ...snapshot, cpuProcesses: [] }} hideEmptyBlocks />)
    expect(markup).toContain('GPU 进程')
    expect(markup).not.toContain('CPU 进程')
  })

  it('collapses process details when the selected row is clicked again', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<ProcessBlocks snapshot={snapshot} />))
    const row = container.querySelector<HTMLTableRowElement>('.process-table--gpu tbody tr')
    expect(row).not.toBeNull()
    await act(async () => row?.click())
    expect(container.querySelector('.process-inline-inspector')).not.toBeNull()
    await act(async () => container.querySelector<HTMLTableRowElement>('.process-table--gpu tbody tr')?.click())
    expect(container.querySelector('.process-inline-inspector')).toBeNull()
    await act(async () => root.unmount())
  })
})
