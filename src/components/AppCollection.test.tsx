// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import type { Server, Snapshot } from '../types/models'
import { DISK_STATUS_INTERVAL_MS } from '../utils/refreshCadence'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
vi.mock('./TrendChart', () => ({ TrendChart: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

globalThis.ResizeObserver = class implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
})

const start = 1_800_000_000_000
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let server: Server
let snapshot: Snapshot

beforeEach(async () => {
  localStorage.clear()
  server = { ...(await api.listServers())[0], remoteHistoryEnabled: false }
  snapshot = { ...(await api.listLatestSnapshots())[0], timestamp: start / 1000 }
  const settings = { ...(await api.getSettings()), idleNotificationsEnabled: false, reduceMotion: true }
  vi.useFakeTimers()
  vi.setSystemTime(start)
  vi.spyOn(api, 'listServers').mockResolvedValue([server])
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue([snapshot])
  vi.spyOn(api, 'getSettings').mockResolvedValue(settings)
  vi.spyOn(api, 'listProjects').mockResolvedValue([])
  vi.spyOn(api, 'listIdleReservations').mockResolvedValue([])
  vi.spyOn(api, 'listServerNotificationSettings').mockResolvedValue([])
  vi.spyOn(api, 'getHistory').mockResolvedValue([])
  vi.spyOn(api, 'getLatestRelease').mockResolvedValue({ version: '1.0.0', url: '' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function render() {
  await act(async () => root.render(<App />))
}

function collectSuccessfully(_serverId: string, includeProcesses = true, includeDisks = true) {
  return Promise.resolve({
    ...snapshot,
    timestamp: Math.floor(Date.now() / 1000),
    processesSampled: includeProcesses,
    disks: includeDisks ? snapshot.disks : [],
  })
}

describe('App disk collection cadence', () => {
  it('throttles a failed disk attempt and retries disks when the interval expires', async () => {
    const collect = vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
      .mockRejectedValueOnce(new Error('连接超时（30 秒）'))
    await render()
    expect(collect).toHaveBeenCalledTimes(1)
    expect(collect.mock.calls[0][2]).toBe(true)

    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(collect).toHaveBeenCalledTimes(2)
    expect(collect.mock.calls[1][2]).toBe(false)

    vi.setSystemTime(start + DISK_STATUS_INTERVAL_MS - 1000)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(collect.mock.lastCall?.[2]).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(collect.mock.lastCall?.[2]).toBe(true)
  })

  it('still allows a manual refresh to collect disks during the cooldown', async () => {
    const collect = vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
    await render()
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(collect.mock.lastCall?.[2]).toBe(false)

    const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '刷新全部')
    expect(refresh).toBeDefined()
    await act(async () => refresh?.click())
    expect(collect.mock.lastCall?.[2]).toBe(true)
  })

  it('does not start the disk cooldown for a lightweight request without disks', async () => {
    vi.mocked(api.listLatestSnapshots).mockResolvedValue([])
    const collect = vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
      .mockRejectedValueOnce(new Error('连接超时（30 秒）'))
    await render()
    expect(collect.mock.calls[0][2]).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(collect.mock.lastCall?.[2]).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(collect.mock.lastCall?.[2]).toBe(true)
  })
})
