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
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
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
const originalDesktop = api.isDesktop
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
  api.isDesktop = originalDesktop
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

it('shows the actual history sync failure when opening the status', async () => {
  api.isDesktop = true
  vi.mocked(api.listServers).mockResolvedValue([{ ...server, remoteHistoryEnabled: true, remoteHistoryLastSyncAt: null }])
  vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
  vi.spyOn(api, 'configureRemoteHistory').mockRejectedValue(new Error('旧版历史入口检查失败'))
  await render()
  await act(async () => vi.advanceTimersByTimeAsync(3_100))
  const status = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.includes('1 台历史同步失败'))
  expect(status).toBeDefined()
  await act(async () => status?.click())
  expect(container.textContent).toContain('历史同步失败：旧版历史入口检查失败')
})

it('queues an edited server for retry even when its last history sync is fresh', async () => {
  api.isDesktop = true
  vi.mocked(api.listServers).mockResolvedValue([{ ...server, remoteHistoryEnabled: true, remoteHistoryLastSyncAt: null }])
  vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
  const configure = vi.spyOn(api, 'configureRemoteHistory')
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('旧版远端历史进程正在退出，等待清理完成后重试'))
    .mockResolvedValue(undefined)
  const sync = vi.spyOn(api, 'syncRemoteHistory').mockResolvedValue({ importedCount: 0, latestTimestamp: start / 1000 })
  vi.spyOn(api, 'saveServer').mockImplementation(async (draft) => ({ ...server, ...draft, id: server.id, remoteHistoryEnabled: true, remoteHistoryLastSyncAt: start / 1000 }))

  await render()
  expect(configure).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledTimes(1)

  const serverRow = container.querySelector<HTMLButtonElement>('.server-row')
  await act(async () => serverRow?.click())
  const connectionTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === '配置')
  await act(async () => connectionTab?.click())
  const editButton = [...container.querySelectorAll<HTMLButtonElement>('.connection-panel button')].find((button) => button.textContent?.includes('编辑配置'))
  await act(async () => editButton?.click())
  const submitButton = container.querySelector<HTMLButtonElement>('.server-form button[type="submit"]')
  await act(async () => submitButton?.click())

  expect(configure).toHaveBeenCalledTimes(3)
  expect(sync).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('旧版远端进程退出中')
  expect(container.textContent).not.toContain('远端历史准备中，将自动重试')
})

it('retries a remote history timeout quickly and returns to sync when reachable', async () => {
  api.isDesktop = true
  vi.mocked(api.listServers).mockResolvedValue([{ ...server, remoteHistoryEnabled: true, remoteHistoryLastSyncAt: null }])
  vi.spyOn(api, 'collectServer').mockImplementationOnce(collectSuccessfully)
    .mockImplementation(() => new Promise(() => {}))
  const configure = vi.spyOn(api, 'configureRemoteHistory')
    .mockRejectedValueOnce(new Error('连接 GPU 节点同步历史超时'))
    .mockRejectedValueOnce(new Error('连接 GPU 节点同步历史超时'))
    .mockRejectedValueOnce(new Error('连接 GPU 节点同步历史超时'))
    .mockResolvedValue(undefined)
  const sync = vi.spyOn(api, 'syncRemoteHistory').mockResolvedValue({ importedCount: 1, latestTimestamp: start / 1000 })

  await render()
  await act(async () => vi.advanceTimersByTimeAsync(3_000))
  expect(configure).toHaveBeenCalledTimes(3)
  expect(sync).not.toHaveBeenCalled()
  expect(container.textContent).toContain('1 台历史同步失败 · 15 秒后重试')

  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(configure).toHaveBeenCalledTimes(4)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(container.textContent).not.toContain('历史同步失败')
})

it('retries all 11 failed history connections automatically and clears the batch status', async () => {
  api.isDesktop = true
  const servers = Array.from({ length: 11 }, (_, index) => ({
    ...server,
    id: `server-${index + 1}`,
    name: `server-${index + 1}`,
    remoteHistoryEnabled: true,
    remoteHistoryLastSyncAt: null,
  }))
  vi.mocked(api.listServers).mockResolvedValue(servers)
  let collectionCalls = 0
  vi.spyOn(api, 'collectServer').mockImplementation((serverId, includeProcesses, includeDisks) => {
    collectionCalls += 1
    if (collectionCalls <= servers.length) return collectSuccessfully(serverId, includeProcesses, includeDisks)
    return new Promise(() => {})
  })
  let failingAttemptsRemaining = servers.length * 3
  const configure = vi.spyOn(api, 'configureRemoteHistory').mockImplementation(async () => {
    if (failingAttemptsRemaining > 0) {
      failingAttemptsRemaining -= 1
      throw new Error('连接 GPU 节点同步历史超时')
    }
  })
  const sync = vi.spyOn(api, 'syncRemoteHistory').mockResolvedValue({ importedCount: 1, latestTimestamp: start / 1000 })

  await render()
  await act(async () => vi.advanceTimersByTimeAsync(3_000))
  expect(configure).toHaveBeenCalledTimes(servers.length * 3)
  expect(sync).not.toHaveBeenCalled()
  expect(container.textContent).toContain('11 台历史同步失败 · 15 秒后重试')

  await act(async () => vi.advanceTimersByTimeAsync(15_000))
  expect(configure).toHaveBeenCalledTimes(servers.length * 4)
  expect(sync).toHaveBeenCalledTimes(servers.length)
  expect(container.textContent).not.toContain('历史同步失败')
})

it('retries legacy cleanup with backoff and resumes history sync when the old daemon exits', async () => {
  api.isDesktop = true
  vi.mocked(api.listServers).mockResolvedValue([{ ...server, remoteHistoryEnabled: true, remoteHistoryLastSyncAt: null }])
  // Keep later live collections pending so this test exercises the periodic
  // retry separately from the existing connection-recovery retry path.
  vi.spyOn(api, 'collectServer').mockImplementationOnce(collectSuccessfully)
    .mockImplementation(() => new Promise(() => {}))
  const configure = vi.spyOn(api, 'configureRemoteHistory')
    .mockRejectedValueOnce(new Error('旧版远端历史进程正在退出，等待清理完成后重试'))
    .mockRejectedValueOnce(new Error('旧版远端历史进程正在退出，等待清理完成后重试'))
    .mockResolvedValue(undefined)
  const sync = vi.spyOn(api, 'syncRemoteHistory').mockResolvedValue({ importedCount: 1, latestTimestamp: start / 1000 })

  await render()
  expect(configure).toHaveBeenCalledTimes(1)
  expect(sync).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('旧版远端进程退出中')

  await act(async () => vi.advanceTimersByTimeAsync(15_000 - 1))
  expect(configure).toHaveBeenCalledTimes(1)
  expect(sync).not.toHaveBeenCalled()
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(configure).toHaveBeenCalledTimes(2)
  expect(container.textContent).not.toContain('旧版远端进程退出中')

  await act(async () => vi.advanceTimersByTimeAsync(30_000))
  expect(configure).toHaveBeenCalledTimes(3)
  expect(sync).toHaveBeenCalledTimes(1)
  expect(sync).toHaveBeenCalledWith(server.id)
  expect(container.textContent).not.toContain('旧版远端进程退出中')
  expect(container.textContent).not.toContain('历史同步失败')
})
