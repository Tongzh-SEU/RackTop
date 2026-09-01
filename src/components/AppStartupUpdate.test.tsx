// @vitest-environment jsdom

import { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import { loadCachedUpdate, saveCachedUpdate, UPDATE_CHECK_INTERVAL_MS } from '../utils/updateCheck'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
})

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('App startup update check', () => {
  it('checks on app mount without resetting the persisted 24-hour schedule', async () => {
    const now = 1_800_000_000_000
    const lastScheduledCheckAt = now - 20 * 60 * 60 * 1000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    saveCachedUpdate({ lastCheckedAt: now, lastScheduledCheckAt, release: undefined })
    const setTimeout = vi.spyOn(window, 'setTimeout')
    const getLatestRelease = vi.spyOn(api, 'getLatestRelease').mockResolvedValue({
      version: '1.25.4',
      url: 'https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4',
    })
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<StrictMode><App /></StrictMode>)
      await Promise.resolve()
    })

    expect(getLatestRelease).toHaveBeenCalledOnce()
    expect(loadCachedUpdate().lastScheduledCheckAt).toBe(lastScheduledCheckAt)
    const remainingDelay = 4 * 60 * 60 * 1000
    const scheduledCheck = setTimeout.mock.calls.find(([, delay]) => delay === remainingDelay)?.[0]
    expect(scheduledCheck).toBeTypeOf('function')
    if (typeof scheduledCheck !== 'function') throw new Error('Scheduled update callback was not registered')
    await act(async () => {
      scheduledCheck()
      await Promise.resolve()
    })
    expect(getLatestRelease).toHaveBeenCalledTimes(2)
    expect(loadCachedUpdate().lastScheduledCheckAt).toBe(now)
  })

  it('opens the current release notes from the About update row', async () => {
    vi.spyOn(api, 'getLatestRelease').mockResolvedValue({
      version: '1.25.4',
      url: 'https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4',
    })
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(<App />)
      await Promise.resolve()
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="关于 RackTop"]')?.click()
    })
    const releaseNotes = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '版本说明')
    expect(releaseNotes).toBeDefined()
    await act(async () => releaseNotes?.click())
    expect(open).toHaveBeenCalledWith(
      'https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.4',
      '_blank',
      'noopener,noreferrer',
    )
    const xiaohongshu = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('小红书'))
    expect(xiaohongshu).toBeDefined()
    await act(async () => xiaohongshu?.click())
    expect(open).toHaveBeenLastCalledWith(
      'https://xhslink.cn/o/AsgFqJMZfR5',
      '_blank',
      'noopener,noreferrer',
    )
  })
})
