import type { Server, SlurmOverview, Snapshot } from '../types/models'
import { clampPercent } from './gpu'

const maxSampleAgeSeconds = 120
const normalizeHost = (value: string) => {
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  return host === '(null)' || host === 'n/a' ? '' : host
}

function slurmNode(overview: SlurmOverview, name: string) {
  return Object.hasOwn(overview.nodes, name) ? overview.nodes[name] : undefined
}

function matchesNodeHostname(expected: string, actual: string) {
  return !!expected && !!actual && (expected === actual || (!expected.includes('.') && actual.startsWith(`${expected}.`)))
}

export function slurmNodeSamples(overview: SlurmOverview, servers: Server[], snapshots: Record<string, Snapshot>, now: number, queryServerId?: string) {
  const serversByHost = new Map<string, Server[]>()
  for (const server of servers) {
    const host = normalizeHost(server.host)
    const matches = serversByHost.get(host) ?? []
    matches.push(server)
    serversByHost.set(host, matches)
  }
  const candidatesByNode = new Map<string, { serverId: string; snapshot: Snapshot }>()
  const nodesByServer = new Map<string, number>()
  const names = new Set(overview.partitions.flatMap((partition) => partition.nodeNames))
  const queryServer = queryServerId ? servers.find((server) => server.id === queryServerId) : undefined
  const queryHostname = normalizeHost(overview.queryHostname ?? '')
  for (const name of names) {
    const node = slurmNode(overview, name)
    const identities = [name, node?.hostname ?? '', node?.address ?? '', ...(node?.resolvedAddresses ?? [])].map(normalizeHost).filter(Boolean)
    const candidates = new Set(identities.flatMap((identity) => serversByHost.get(identity) ?? []))
    const expected = normalizeHost(node?.hostname ?? '') || normalizeHost(name)
    if (queryServer && matchesNodeHostname(expected, queryHostname)) candidates.add(queryServer)
    const server = candidates.size === 1 ? candidates.values().next().value : undefined
    const snapshot = server ? snapshots[server.id] : undefined
    if (!server || !snapshot || server.status === 'offline' || snapshot.timestamp > now || now - snapshot.timestamp > maxSampleAgeSeconds) continue

    const actual = normalizeHost(snapshot.hostname)
    if (!matchesNodeHostname(expected, actual) || (server === queryServer && queryHostname && !matchesNodeHostname(queryHostname, actual))) continue

    candidatesByNode.set(name, { serverId: server.id, snapshot })
    nodesByServer.set(server.id, (nodesByServer.get(server.id) ?? 0) + 1)
  }
  const samples = new Map<string, Snapshot>()
  for (const [name, { serverId, snapshot }] of candidatesByNode) {
    if (nodesByServer.get(serverId) === 1) samples.set(name, snapshot)
  }
  return samples
}

export function slurmPartitionResources(overview: SlurmOverview, partition: SlurmOverview['partitions'][number], samples: Map<string, Snapshot>) {
  const nodes = partition.nodeNames.map((name) => ({ name, node: slurmNode(overview, name), sample: samples.get(name) }))

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
