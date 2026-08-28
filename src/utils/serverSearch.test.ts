import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { serverMatchesSearch } from './serverSearch'

const server: Server = {
  id: 'server-1', name: '六卡训练机', location: '机房 A', host: '10.201.37.233', port: 22, username: 'tongzh', sshAlias: 'gpu-233', proxyJump: null, tags: ['训练', '4090'], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: true, authMethod: 'sshAgent', status: 'online',
}

const snapshot: Snapshot = {
  serverId: server.id, hostname: 'ubuntu-node-12', username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu 24.04 LTS', timestamp: 1, status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'AMD EPYC 9654 96-Core Processor', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 0, memoryTotalBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [{ index: 0, uuid: 'GPU-ABC-123', name: 'NVIDIA GeForce RTX 4090', utilization: 0, memoryUtilization: 0, memoryUsedMb: 0, memoryTotalMb: 24_576, temperatureCelsius: 30, powerWatts: 20 }],
  processes: [], cpuProcesses: [],
}

describe('serverMatchesSearch', () => {
  it.each(['六卡', '10.201.37.233', 'gpu-233', '机房 a', 'ubuntu-node', '24.04', 'epyc 9654', 'RTX 4090', 'gpu-abc'])('matches server identity and hardware information: %s', (query) => {
    expect(serverMatchesSearch(server, snapshot, query)).toBe(true)
  })

  it('matches terms across CPU and GPU fields', () => {
    expect(serverMatchesSearch(server, snapshot, 'AMD 4090')).toBe(true)
  })

  it('does not match unrelated information', () => {
    expect(serverMatchesSearch(server, snapshot, 'Intel A100')).toBe(false)
  })
})
