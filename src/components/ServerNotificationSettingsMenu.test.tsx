// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerNotificationSettingsMenu } from '../App'
import { defaultServerNotificationSettings } from '../utils/serverNotifications'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn(() => ({ matches: true })),
})
window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0)
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle)
Element.prototype.scrollIntoView = vi.fn()

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('ServerNotificationSettingsMenu', () => {
  it('opens directly in partial mode and stays open while selecting categories', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onOpenRequestHandled = vi.fn()

    await act(async () => {
      root?.render(<ServerNotificationSettingsMenu
        settings={defaultServerNotificationSettings('server')}
        onChange={vi.fn()}
        openRequested
        onOpenRequestHandled={onOpenRequestHandled}
      />)
    })

    expect(container.querySelector('.notification-menu__trigger')?.textContent).toContain('部分')
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(container.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toContain('部分')
    expect(onOpenRequestHandled).toHaveBeenCalledOnce()

    const categories = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    await act(async () => categories[0].click())
    await act(async () => categories[1].click())

    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    expect(container.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"]')).toHaveLength(2)
  })
})
