import { expect, it } from 'vitest'
import type { Server, SlurmOverview, Snapshot } from '../types/models'
import { slurmNodeSamples, slurmPartitionResources } from './slurm'

it('only aggregates current, uniquely matched node samples and weights CPU by core capacity', () => {
  const node = { hostname: '', address: '', state: 'IDLE', cpuTotal: 16, cpuAllocated: 4, gpuTypes: [] }
  const partition = { name: 'compute', nodeNames: ['a', 'b', 'c', 'd'] }
  const overview: SlurmOverview = { username: 'me', jobs: [], partitions: [partition], nodes: { a: node, b: node, c: node, d: node } }
  const servers = ['a', 'b', 'c', 'd', 'D.'].map((host, index) => ({ id: String(index), host, status: 'online' }) as Server)
  const snapshot = (hostname: string, cpuUtilization: number, cpuLogicalCores: number, timestamp = 500) => (
    { hostname, timestamp, system: { cpuUtilization, cpuLogicalCores } } as Snapshot
  )
  const snapshots = { 0: snapshot('a', 0, 8), 1: snapshot('b.local', 100, 24), 2: snapshot('c', 100, 128, 379), 3: snapshot('d', 100, 128), 4: snapshot('d', 100, 128) }
  const resources = slurmPartitionResources(overview, partition, slurmNodeSamples(overview, servers, snapshots, 500))
  expect(resources.cpuPercent).toBe(75)
  expect(resources.sampledNodes).toBe(2)
  expect(resources.cpuTotal).toBe(64)
  expect(resources.cpuAllocated).toBe(16)
})

it('rejects a conflicting runtime hostname and never assigns one sample to multiple nodes across partitions', () => {
  const node = { hostname: 'worker', address: '10.0.0.1', state: 'IDLE', cpuTotal: 16, cpuAllocated: 0, gpuTypes: [] }
  const partition = { name: 'compute', nodeNames: ['worker-01'] }
  const server = { id: 's1', host: '10.0.0.1', status: 'online' } as Server
  const overview: SlurmOverview = { username: 'me', jobs: [], partitions: [partition], nodes: { 'worker-01': node, 'worker-02': node } }
  const snapshots = (hostname: string) => ({ s1: { hostname, timestamp: 500 } as Snapshot })
  expect(slurmNodeSamples(overview, [server], snapshots('wrong-host'), 500).size).toBe(0)
  expect(slurmNodeSamples(overview, [server], snapshots('worker'), 500).size).toBe(1)
  overview.partitions.push({ name: 'other', nodeNames: ['worker-01'] })
  expect(slurmNodeSamples(overview, [server], snapshots('worker'), 500).size).toBe(1)
  overview.partitions[1].nodeNames.push('worker-02')
  expect(slurmNodeSamples(overview, [server], snapshots('worker'), 500).size).toBe(0)
})

it('uses the SSH query hostname to match the selected connection when its IP is an alias', () => {
  const node = { hostname: 'worker', address: '10.0.0.1', state: 'IDLE', cpuTotal: 16, cpuAllocated: 0, gpuTypes: [] }
  const overview: SlurmOverview = { username: 'me', queryHostname: 'worker', jobs: [], partitions: [{ name: 'compute', nodeNames: ['worker'] }], nodes: { worker: node } }
  const server = { id: 's1', host: '192.168.0.1', status: 'online' } as Server
  const snapshot = { hostname: 'worker', timestamp: 500 } as Snapshot
  expect(slurmNodeSamples(overview, [server], { s1: snapshot }, 500, 's1').get('worker')).toBe(snapshot)
  expect(slurmNodeSamples(overview, [server], { s1: snapshot }, 500, 'other').size).toBe(0)
  expect(slurmNodeSamples(overview, [server], { s1: { ...snapshot, hostname: 'login' } }, 500, 's1').size).toBe(0)
  const duplicate = { ...server, id: 's2', host: '10.0.0.1' }
  expect(slurmNodeSamples(overview, [server, duplicate], { s1: snapshot, s2: snapshot }, 500, 's1').size).toBe(0)
})

it('uses a resolved node address only when the sample also confirms the hostname', () => {
  const node = { hostname: 'worker', address: 'worker.local', resolvedAddresses: ['192.0.2.1'], state: 'IDLE', cpuTotal: 16, cpuAllocated: 0, gpuTypes: [] }
  const overview: SlurmOverview = { username: 'me', jobs: [], partitions: [{ name: 'compute', nodeNames: ['worker'] }], nodes: { worker: node } }
  const server = { id: 's1', host: '192.0.2.1', status: 'online' } as Server
  const snapshot = { hostname: 'worker', timestamp: 500 } as Snapshot
  expect(slurmNodeSamples(overview, [server], { s1: snapshot }, 500).get('worker')).toBe(snapshot)
  expect(slurmNodeSamples(overview, [server], { s1: { ...snapshot, hostname: 'unrelated' } }, 500).size).toBe(0)
})
