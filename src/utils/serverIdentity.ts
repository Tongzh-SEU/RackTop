import type { Server, ServerDraft } from '../types/models'

type ConnectionTarget = Pick<Server | ServerDraft, 'host' | 'port' | 'username'>

export function serverConnectionKey(target: ConnectionTarget) {
  return `${target.username.trim()}@${target.host.trim().toLowerCase()}:${target.port}`
}

export function duplicateImportIndexes(drafts: ServerDraft[], servers: Server[]) {
  const seen = new Set(servers.map(serverConnectionKey))
  const duplicates = new Set<number>()

  drafts.forEach((draft, index) => {
    const key = serverConnectionKey(draft)
    if (seen.has(key)) duplicates.add(index)
    else seen.add(key)
  })

  return duplicates
}
