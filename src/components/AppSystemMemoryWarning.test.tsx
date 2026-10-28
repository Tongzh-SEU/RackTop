// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import type { Server, Snapshot } from '../types/models'
import { IGNORED_SYSTEM_MEMORY_KEY } from '../utils/systemMemoryWarning'

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
  snapshot = { ...(await api.listLatestSnapshots())[0], timestamp: start / 1000, nvidiaSmi: 'available', status: 'online', gpus: [], processes: [] }
  const settings = { ...(await api.getSettings()), idleNotificationsEnabled: true, reduceMotion: true }
  vi.useFakeTimers()
  vi.setSystemTime(start)
  vi.spyOn(api, 'listServers').mockResolvedValue([server])
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue([snapshot])
  vi.spyOn(api, 'getSettings').mockResolvedValue(settings)
  vi.spyOn(api, 'listProjects').mockResolvedValue([])
  vi.spyOn(api, 'listIdleReservations').mockResolvedValue([])
  vi.spyOn(api, 'listServerNotificationSettings').mockResolvedValue([])
  vi.spyOn(api, 'getHistory').mockResolvedValue([])
  vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
  vi.spyOn(api, 'notify').mockResolvedValue(undefined)
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



async function refresh() {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '刷新全部')!
  await act(async () => button.click())
}
function useMemory(percent: number) {
  snapshot = { ...snapshot, system: { ...snapshot.system, memoryTotalBytes: 1000, memoryUsedBytes: percent * 10 } }
  vi.mocked(api.listLatestSnapshots).mockResolvedValue([snapshot])
}

describe('system MEM warnings', () => {
  it('notifies once per high-memory episode and rearms after recovery', async () => {
    useMemory(91)
    await render()
    expect(api.notify).toHaveBeenCalledTimes(1)
    expect(api.notify).toHaveBeenCalledWith(expect.stringContaining('系统 MEM 告警'), expect.stringContaining('91.0%'))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.notify).toHaveBeenCalledTimes(1)
    useMemory(90)
    await refresh()
    expect(container.textContent).not.toContain('系统 MEM 告警 ·')
    useMemory(92)
    await act(async () => vi.advanceTimersByTimeAsync(1200))
    expect(api.notify).toHaveBeenCalledTimes(2)
  })

  it('obeys the global notification switch even when memory remains high', async () => {
    const settings = await api.getSettings()
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, idleNotificationsEnabled: false })
    useMemory(99)
    await render()
    expect(api.notify).not.toHaveBeenCalled()
    expect(container.textContent).toContain('系统 MEM 告警 · 99.0%')
  })

  it('obeys the server system notification category', async () => {
    vi.mocked(api.listServerNotificationSettings).mockResolvedValue([{serverId:server.id,mode:'partial',task:true,zombie:true,memory:true,system:false}])
    useMemory(99)
    await render()
    expect(api.notify).not.toHaveBeenCalled()
  })

  it('persists ignored memory alerts, restores them and removes them on recovery', async () => {
    useMemory(95)
    await render()
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    const ignore = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b)=>b.textContent==='忽略系统 MEM 告警')!
    await act(async () => ignore.click())
    expect(JSON.parse(localStorage.getItem(IGNORED_SYSTEM_MEMORY_KEY)!)).toEqual([server.id])
    await act(async () => root.unmount())
    root = createRoot(container)
    vi.mocked(api.notify).mockClear()
    await render()
    expect(api.notify).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    const config = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent==='配置')!
    await act(async () => config.click())
    expect(container.querySelector('.ignored-warning-list')?.textContent).toContain('系统 MEM 告警')
    const restore = container.querySelector<HTMLButtonElement>('.ignored-warning-row button')!
    await act(async () => restore.click())
    await act(async () => vi.advanceTimersByTimeAsync(2200))
    expect(api.notify).toHaveBeenCalledTimes(1)
    useMemory(80)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新当前服务器"]')!.click())
    expect(container.querySelector('.ignored-warning-list')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
