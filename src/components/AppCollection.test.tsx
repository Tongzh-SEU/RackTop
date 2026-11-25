// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import type { Server, Snapshot } from '../types/models'

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

describe('App disk collection trigger', () => {
  it('keeps recurring background samples disk-free, including after a failed attempt', async () => {
    const collect = vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
      .mockRejectedValueOnce(new Error('连接超时（30 秒）'))
    await render()
    expect(collect).toHaveBeenCalledTimes(1)
    expect(collect.mock.calls[0][2]).toBe(false)

    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(collect).toHaveBeenCalledTimes(2)
    expect(collect.mock.calls[1][2]).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(collect.mock.calls.every((call) => call[2] === false)).toBe(true)
  })

  it('still allows an explicit manual refresh to collect disks', async () => {
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

  it('keeps background collection disk-free without a previous snapshot', async () => {
    vi.mocked(api.listLatestSnapshots).mockResolvedValue([])
    const collect = vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
      .mockRejectedValueOnce(new Error('连接超时（30 秒）'))
    await render()
    expect(collect.mock.calls[0][2]).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(collect.mock.lastCall?.[2]).toBe(false)
    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(collect.mock.lastCall?.[2]).toBe(false)
  })
})

it('opens Slurm on automatically detected servers and hides it on ordinary servers', async () => {
  const enabled = { ...server, slurmEnabled: false }
  const other = { ...server, id: 'ordinary', name: 'Ordinary server', slurmEnabled: false }
  vi.mocked(api.listServers).mockResolvedValue([enabled, other])
  vi.mocked(api.listLatestSnapshots).mockResolvedValue([snapshot, { ...snapshot, serverId: other.id }])
  vi.spyOn(api, 'collectServer').mockImplementation(async (serverId) => ({ ...snapshot, serverId, slurmAvailable: serverId === enabled.id }))
  const collectSlurm = vi.spyOn(api, 'collectSlurm').mockResolvedValue({ username: 'me', partitions: [], nodes: {}, jobs: [] })
  await render()

  const [firstRow, secondRow] = container.querySelectorAll<HTMLButtonElement>('.server-row')
  await act(async () => firstRow.click())
  const slurmTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === 'Slurm')!
  expect(collectSlurm).not.toHaveBeenCalled()
  await act(async () => slurmTab.click())
  expect(collectSlurm).toHaveBeenCalledExactlyOnceWith(enabled.id, 0)
  expect(container.textContent).toContain('等待作业列表')

  await act(async () => secondRow.click())
  expect([...container.querySelectorAll('[role="tab"]')].some((button) => button.textContent === 'Slurm')).toBe(false)
  expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('概览')
  expect(collectSlurm).toHaveBeenCalledTimes(1)
})

it('opens Slurm through a confirmed login node when the selected compute node lacks the client', async () => {
  api.isDesktop = true
  const login = { ...server, name: 'Slurm login', slurmEnabled: true }
  const worker = { ...server, id: 'worker', name: 'Compute worker', host: 'compute.cluster', slurmEnabled: false }
  const workerSnapshot = { ...snapshot, serverId: worker.id, hostname: worker.host, slurmAvailable: false }
  vi.mocked(api.listServers).mockResolvedValue([login, worker])
  vi.mocked(api.listLatestSnapshots).mockResolvedValue([snapshot, workerSnapshot])
  vi.spyOn(api, 'collectServer').mockImplementation(async (id) => id === worker.id ? workerSnapshot : snapshot)
  const overview = { username: 'me', partitions: [{ name: 'gpu', nodeNames: ['compute'] }], nodes: { compute: { hostname: worker.host, address: worker.host, state: 'idle', cpuTotal: null, cpuAllocated: null, gpuTypes: [] } }, jobs: [] }
  const collectSlurm = vi.spyOn(api, 'collectSlurm').mockResolvedValue(overview)
  await render()
  expect(collectSlurm.mock.calls).toEqual([[login.id, 0, false]])

  await act(async () => container.querySelectorAll<HTMLButtonElement>('.server-row')[1].click())
  const slurmTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === 'Slurm')!
  await act(async () => slurmTab.click())
  expect(collectSlurm.mock.calls).toEqual([[login.id, 0, false], [login.id, 0]])
  expect(container.textContent).toContain('查询来源 Slurm login')
})

it('discards the previous Slurm request when the SSH settings are saved under the same server ID', async () => {
  const enabled = { ...server, slurmEnabled: true }
  vi.mocked(api.listServers).mockResolvedValue([enabled])
  vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
  vi.spyOn(api, 'saveServer').mockResolvedValue({ ...enabled, username: 'new-account' })
  const oldData = { username: 'old-account', partitions: [], nodes: {}, jobs: [{ id: '1', user: 'old-account', name: 'old queue', partition: 'gpu', cpus: 1, reason: 'Priority' }] }
  let finishOld!: (value: typeof oldData) => void
  const collectSlurm = vi.spyOn(api, 'collectSlurm')
    .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve }))
    .mockResolvedValueOnce({ username: 'new-account', partitions: [], nodes: {}, jobs: [{ ...oldData.jobs[0], user: 'new-account', name: 'new queue' }] })
  await render()
  await act(async () => container.querySelector<HTMLButtonElement>('.server-row')!.click())
  const slurmTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === 'Slurm')!
  await act(async () => slurmTab.click())
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="编辑服务器"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('.server-form button[type="submit"]')!.click())
  expect(collectSlurm.mock.calls).toEqual([[enabled.id, 0], [enabled.id, 1]])
  await act(async () => finishOld(oldData))
  expect(container.querySelector('.slurm-queue')?.textContent).toContain('new queue')
  expect(container.querySelector('.slurm-queue')?.textContent).not.toContain('old queue')
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
