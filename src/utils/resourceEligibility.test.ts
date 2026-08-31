import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { evaluateResourceEligibility } from './resourceEligibility'

const now = 1_800_000_000
const server: Server = { id: 'server', name: '2*5090', host: '10.0.0.1', port: 22, username: 'tongzh', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 30, remoteHistoryEnabled: true, authMethod: 'sshAgent', status: 'online' }
const snapshot: Snapshot = {
  serverId: server.id, hostname: server.name, username: 'tongzh', osId: 'ubuntu', osName: 'Ubuntu', timestamp: now - 2, status: 'online',
  system: { cpuModel: 'EPYC', cpuUtilization: 10, currentUserCpuUtilization: 2, load1: 1, load5: 1, load15: 1, memoryUsedBytes: 1, memoryTotalBytes: 2, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [{ index: 0, uuid: 'gpu-0', name: 'RTX 5090', utilization: 2, memoryUtilization: 25, memoryUsedMb: 8192, memoryTotalMb: 32768, temperatureCelsius: 44, powerWatts: 80 }],
  processes: [], cpuProcesses: [], processesSampled: true, nvidiaSmi: 'available',
}
const historyPoint = (timestamp: number) => ({ timestamp, cpuUtilization: 10, memoryUtilization: 20, swapUtilization: 0, gpuUtilizations: { 'gpu-0': 2 }, gpuMemoryUtilizations: { 'gpu-0': 25 } })

describe('evaluateResourceEligibility', () => {
  it('accepts a fresh resource with enough memory and covered history', () => {
    const result = evaluateResourceEligibility(server, snapshot, 'gpu-0', { minimumGpuMemoryGb: 12, durationMinutes: 60, excludeOtherUsers: true }, [historyPoint(snapshot.timestamp - 3600), historyPoint(snapshot.timestamp)], now)
    expect(result.status).toBe('eligible')
  })

  it('does not recommend a stale snapshot', () => {
    const result = evaluateResourceEligibility(server, { ...snapshot, timestamp: now - 600 }, 'gpu-0', { minimumGpuMemoryGb: 12, durationMinutes: 0, excludeOtherUsers: true }, [], now)
    expect(result.status).toBe('stale')
  })

  it('distinguishes insufficient history from an occupied GPU', () => {
    const result = evaluateResourceEligibility(server, snapshot, 'gpu-0', { minimumGpuMemoryGb: 12, durationMinutes: 60, excludeOtherUsers: true }, [], now)
    expect(result.status).toBe('insufficient')
  })
})
