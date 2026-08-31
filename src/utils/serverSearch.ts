import type { Server, Snapshot } from '../types/models'

function searchableServerValues(server: Server, snapshot?: Snapshot) {
  return [
    server.name,
    server.location,
    server.host,
    server.port,
    server.username,
    server.sshAlias,
    server.proxyJump,
    ...server.tags,
    snapshot?.hostname,
    snapshot?.username,
    snapshot?.osId,
    snapshot?.osName,
    snapshot?.system.cpuModel,
    ...snapshot?.gpus.flatMap((gpu) => [gpu.name, gpu.uuid]) ?? [],
  ].filter((value): value is string | number => value !== null && value !== undefined)
}

export function serverMatchesSearch(server: Server, snapshot: Snapshot | undefined, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const haystack = searchableServerValues(server, snapshot).join('\n').toLocaleLowerCase()
  return terms.every((term) => haystack.includes(term))
}
