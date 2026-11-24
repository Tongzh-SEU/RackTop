// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import type { DiskScanState } from '../types/models'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  localStorage.clear()
})

it.each(['success', 'failure', 'empty', 'stale'])('continues monitoring while du is pending and after %s without marking the server offline', async (outcome) => {
  const servers = await api.listServers()
  const snapshot = await api.collectServer(servers[0].id)
  vi.spyOn(api, 'listServers').mockResolvedValue([servers[0]])
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue([snapshot])
  vi.spyOn(api, 'getLatestRelease').mockResolvedValue({ version: '1.25.5', url: 'https://github.com/Tongzh-SEU/RackTop/releases/tag/v1.25.5' })
  vi.spyOn(api, 'getDiskScan').mockResolvedValue(null)
  const collect = vi.spyOn(api, 'collectServer').mockResolvedValue({ ...snapshot, disks: snapshot.disks?.map((disk) => ({ ...disk, currentUserUsedBytes: null })) })
  const notify = vi.spyOn(api, 'notify').mockResolvedValue(undefined)
  let rejectUsage!: (error: Error) => void
  let resolveUsage!: (usage: DiskScanState) => void
  const usage = vi.spyOn(api, 'collectDiskUsage').mockImplementation(() => new Promise((resolve, reject) => { rejectUsage = reject; resolveUsage = resolve }))
  vi.useFakeTimers()
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<App />) })
  for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(usage).not.toHaveBeenCalled()
  expect(collect.mock.calls.length).toBeGreaterThan(1)
  expect(collect.mock.calls.every((call) => call[2] === false)).toBe(true)
  await act(async () => { container.querySelector<HTMLButtonElement>('button.server-row')!.click() })
  await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '趋势')!.click() })
  for (let i = 0; i < 2; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(usage).toHaveBeenCalledWith(servers[0].id, snapshot.disks?.map((disk) => disk.mountPoint), true)
  const before = collect.mock.calls.length
  if (outcome === 'stale') {
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '刷新全部')!.click() })
    expect(usage).toHaveBeenCalledOnce()
  }
  await act(async () => {
    if (outcome === 'failure') rejectUsage(new Error('用户目录统计超时'))
    else resolveUsage({ serverId: servers[0].id, queued: false, running: false, lastAttemptAt: 100, nextRefreshAt: 86400, retryAt: null, mounts: [] })
    await Promise.resolve()
  })
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(collect.mock.calls.length).toBeGreaterThan(before)
  expect(usage).toHaveBeenCalledOnce()
  expect(notify.mock.calls.some(([title]) => title.includes('已离线'))).toBe(false)
  expect(container.querySelector('.status-pill')?.textContent).toContain('在线')
  const storage = container.querySelector('.storage-waffle-panel')
  expect(storage?.textContent).toContain('总计')
})
