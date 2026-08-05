import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../types/models'
import { ProcessBlocks } from './ProcessBlocks'

const snapshot: Snapshot = {
  serverId: 'server-1', hostname: 'gpu-box', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [],
  processes: [{ gpuUuid: 'gpu-0', gpuIndex: 0, pid: 21_312, parentPid: 1, username: 'tongzh', command: 'python train.py', memoryUsedMb: 1024, smUtilization: 73, cpuPercent: 20, elapsed: '01:00', isCurrentUser: true, isGroupLeader: true }],
  cpuProcesses: [{ pid: 2_212, parentPid: 21_312, username: 'tongzh', command: 'python worker.py', cpuPercent: 10, memoryPercent: 1, memoryUsedBytes: 1024, elapsed: '00:30', isCurrentUser: true, isGroupLeader: false }],
}

describe('ProcessBlocks', () => {
  it('renders the CPU block below the GPU block with their relationship', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={snapshot} compact onRequestTerminate={() => {}} />)
    expect(markup.indexOf('GPU 进程')).toBeLessThan(markup.indexOf('CPU 进程'))
    expect(markup).toContain('<th>GPU</th><th>PID</th>')
    expect(markup).not.toContain('<th>GPU · PID</th>')
    expect(markup).toContain('<th>用户</th>')
    expect(markup).toContain('tongzh')
    expect(markup).toContain('CPU 子进程 PID 2212')
    expect(markup).toContain('GPU 0 · PID 21312 的子进程')
  })

  it('only offers termination selection for the current user group leader', () => {
    const markup = renderToStaticMarkup(<ProcessBlocks snapshot={snapshot} onRequestTerminate={() => {}} />)
    expect(markup.match(/type="checkbox"/g)).toHaveLength(1)
    expect(markup).toContain('选择结束 PID 21312')
    expect(markup).not.toContain('选择结束 PID 2212')
  })
})
