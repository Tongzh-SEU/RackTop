import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Server } from '../types/models'
import { DeleteServerDialog } from './DeleteServerDialog'

const server: Server = {
  id: 'server-1',
  name: 'GPU Server',
  host: '10.0.0.10',
  port: 22,
  username: 'alice',
  tags: [],
  samplingIntervalSeconds: 2,
  historyRetentionDays: 90,
  remoteHistoryEnabled: true,
  authMethod: 'privateKey',
  status: 'online',
}

describe('DeleteServerDialog', () => {
  it('offers exact SSH access revocation for the RackTop managed key', () => {
    const markup = renderToStaticMarkup(<DeleteServerDialog server={{ ...server, identityFile: '~/.ssh/racktop_ed25519' }} onClose={vi.fn()} onDelete={vi.fn()} />)
    expect(markup).toContain('同时撤销 RackTop 配置的免密登录')
    expect(markup).toContain('authorized_keys')
    expect(markup).toContain('type="checkbox"')
    expect(markup).not.toContain('checked=""')
  })

  it('does not offer automatic revocation for a user-owned key', () => {
    const markup = renderToStaticMarkup(<DeleteServerDialog server={{ ...server, identityFile: '~/.ssh/id_ed25519' }} onClose={vi.fn()} onDelete={vi.fn()} />)
    expect(markup).not.toContain('同时撤销 RackTop 配置的免密登录')
  })
})
