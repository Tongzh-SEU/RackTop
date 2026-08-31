import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from './external'

describe('openExternalUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens links in a separate browser context during web previews', async () => {
    const open = vi.fn(() => ({} as Window))
    vi.stubGlobal('window', { open })

    await openExternalUrl('https://github.com/Tongzh-SEU/RackTop')

    expect(open).toHaveBeenCalledWith('https://github.com/Tongzh-SEU/RackTop', '_blank', 'noopener,noreferrer')
  })

  it('does not treat a null noopener return value as an open failure', async () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) })

    await expect(openExternalUrl('https://github.com/Tongzh-SEU')).resolves.toBeUndefined()
  })
})
