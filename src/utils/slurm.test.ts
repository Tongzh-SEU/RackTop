import { expect, it } from 'vitest'
import type { Server, SlurmOverview, Snapshot } from '../types/models'
import { slurmPartitionResources } from './slurm'

it('only aggregates current, uniquely matched node samples and weights CPU by core capacity', () => {
  const node = { hostname: '', address: '', state: 'IDLE', cpuTotal: 16, cpuAllocated: 4, gpuTypes: [] }
  const partition = { name: 'compute', nodeNames: ['a', 'b', 'c', 'd'] }
  const overview: SlurmOverview = { username: 'me', jobs: [], partitions: [partition], nodes: { a: node, b: node, c: node, d: node } }
  const servers = ['a', 'b', 'c', 'd', 'D.'].map((host, index) => ({ id: String(index), host, status: 'online' }) as Server)
  const snapshot = (cpuUtilization: number, cpuLogicalCores: number, timestamp = 500) => (
    { timestamp, system: { cpuUtilization, cpuLogicalCores } } as Snapshot
  )
  const snapshots = { 0: snapshot(0, 8), 1: snapshot(100, 24), 2: snapshot(100, 128, 379), 3: snapshot(100, 128), 4: snapshot(100, 128) }
  const resources = slurmPartitionResources(overview, partition, servers, snapshots, 500)
  expect(resources.cpuPercent).toBe(75)
  expect(resources.sampledNodes).toBe(2)
  expect(resources.cpuTotal).toBe(64)
  expect(resources.cpuAllocated).toBe(16)
})
