import type { Server, SlurmOverview, Snapshot } from '../types/models'
import { clampPercent } from './gpu'

const maxSampleAgeSeconds = 120
const normalizeHost = (value: string) => value.trim().toLowerCase().replace(/\.$/, '')

export function slurmPartitionResources(overview: SlurmOverview, partition: SlurmOverview['partitions'][number], servers: Server[], snapshots: Record<string, Snapshot>, now: number) {
  const serversByHost = new Map<string, Server[]>()
  for (const server of servers) {
    const host = normalizeHost(server.host)
    const matches = serversByHost.get(host) ?? []
    matches.push(server)
    serversByHost.set(host, matches)
  }
  const nodes = partition.nodeNames.map((name) => {
    const node = Object.hasOwn(overview.nodes, name) ? overview.nodes[name] : undefined
    const identities = [name, node?.hostname ?? '', node?.address ?? ''].map(normalizeHost).filter(Boolean)
    const candidates = new Set(identities.flatMap((identity) => serversByHost.get(identity) ?? []))
    const server = candidates.size === 1 ? candidates.values().next().value : undefined
    const snapshot = server ? snapshots[server.id] : undefined
    const sample = snapshot && server?.status !== 'offline' && snapshot.timestamp <= now && now - snapshot.timestamp <= maxSampleAgeSeconds
      ? snapshot
      : undefined
    return { name, node, sample }
  })

  const usage = nodes.reduce((total, { node, sample }) => {
    if (!sample || !Number.isFinite(sample.system.cpuUtilization)) return total
    const cores = sample.system.cpuLogicalCores || node?.cpuTotal || 1
    return { busy: total.busy + clampPercent(sample.system.cpuUtilization) * cores, cores: total.cores + cores, count: total.count + 1 }
  }, { busy: 0, cores: 0, count: 0 })
  const cpuTotal = nodes.length > 0 && nodes.every(({ node }) => node?.cpuTotal != null)
    ? nodes.reduce((total, { node }) => total + (node?.cpuTotal ?? 0), 0)
    : null
  const cpuAllocated = nodes.length > 0 && nodes.every(({ node }) => node?.cpuAllocated != null)
    ? nodes.reduce((total, { node }) => total + (node?.cpuAllocated ?? 0), 0)
    : null

  return { nodes, cpuTotal, cpuAllocated, sampledNodes: usage.count, cpuPercent: usage.cores > 0 ? usage.busy / usage.cores : null }
}
