import { describe, expect, it } from 'vitest'
import type { Server, ServerDraft } from '../types/models'
import { duplicateImportIndexes, serverConnectionKey } from './serverIdentity'

const draft = (host: string, username = 'tongzh', port = 22): ServerDraft => ({
  name: host,
  host,
  port,
  username,
  tags: [],
  samplingIntervalSeconds: 2,
  historyRetentionDays: 30,
  authMethod: 'sshConfig',
})

const server = (host: string, username = 'tongzh', port = 22): Server => ({
  ...draft(host, username, port),
  id: host,
  authMethod: 'sshAgent',
  status: 'online',
  lastError: null,
  lastSeenAt: null,
})

describe('server connection identity', () => {
  it('normalizes host casing and surrounding whitespace', () => {
    expect(serverConnectionKey(draft(' GPU.EXAMPLE.COM '))).toBe('tongzh@gpu.example.com:22')
  })

  it('marks existing targets and repeated config aliases as duplicates', () => {
    const duplicates = duplicateImportIndexes(
      [draft('10.0.0.1'), draft('10.0.0.2'), draft('10.0.0.2')],
      [server('10.0.0.1')],
    )
    expect([...duplicates]).toEqual([0, 2])
  })

  it('keeps different users and ports as separate connections', () => {
    expect(duplicateImportIndexes(
      [draft('10.0.0.1', 'alice'), draft('10.0.0.1', 'tongzh', 2222)],
      [server('10.0.0.1')],
    ).size).toBe(0)
  })
})
