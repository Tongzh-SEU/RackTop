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

  it('reports when the browser blocks the new window', async () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) })

    await expect(openExternalUrl('https://github.com/Tongzh-SEU')).rejects.toThrow('浏览器阻止了新窗口')
  })
})
