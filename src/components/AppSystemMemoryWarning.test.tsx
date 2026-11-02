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
  it('counts GPU and system memory warnings together and ignores them independently', async () => {
    useMemory(95)
    const gpu = { index: 0, uuid: 'GPU-mixed', name: 'NVIDIA A100', utilization: 0, memoryUtilization: 0, memoryUsedMb: 8192, memoryTotalMb: 81920, temperatureCelsius: 40, powerWatts: 50 }
    snapshot = { ...snapshot, gpus: [gpu] }
    vi.mocked(api.listLatestSnapshots).mockResolvedValue([snapshot])
    const gpuWarningId = `gpu-memory-stall:${server.id}:${gpu.uuid}`
    localStorage.setItem('racktop.gpuMemoryStallSince.v1', JSON.stringify({ [gpuWarningId]: start / 1000 - 18000 }))
    await render()
    const bell = container.querySelector<HTMLButtonElement>('[aria-label="预约与通知"]')!
    await act(async () => bell.click())
    expect(container.querySelector('.reservation-center-sheet h2')?.textContent).toContain('2 个预警')
    const memoryRow = [...container.querySelectorAll('.reservation-row--warning')].find((row) => row.textContent?.includes('系统 MEM'))!
    await act(async () => memoryRow.querySelector<HTMLButtonElement>('.reservation-row__actions button')!.click())
    expect(container.querySelector('.reservation-center-sheet h2')?.textContent).toContain('1 个预警')
    expect(container.querySelector('.reservation-row--warning')?.textContent).toContain('显存占用预警')
    expect(bell.querySelector('.notification-dot')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('racktop.ignoredGpuMemoryStallWarnings.v1') ?? '[]')).not.toContain(gpuWarningId)
    await act(async () => container.querySelector<HTMLButtonElement>('.reservation-row--warning .reservation-row__actions button')!.click())
    expect(container.querySelector('.reservation-row--warning')).toBeNull()
    expect(bell.querySelector('.notification-dot')).toBeNull()
    expect(JSON.parse(localStorage.getItem(IGNORED_SYSTEM_MEMORY_KEY)!)).toEqual([server.id])
    expect(JSON.parse(localStorage.getItem('racktop.ignoredGpuMemoryStallWarnings.v1')!)).toEqual([gpuWarningId])
  })

  it('opens details from the fleet and card, contains keyboard focus and preserves CPU navigation', async () => {
    useMemory(95)
    await render()
    const fleetWarning = [...container.querySelectorAll<HTMLButtonElement>('.fleet-no-gpu')].find((button) => button.textContent?.includes('系统 MEM'))!
    fleetWarning.focus()
    await act(async () => fleetWarning.click())
    const dialog = container.querySelector<HTMLElement>('.gpu-warning-sheet')!
    expect(dialog.textContent).toContain('95.0%')
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!
    const done = dialog.querySelector<HTMLButtonElement>('footer button')!
    expect(document.activeElement).toBe(close)
    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(done)
    act(() => done.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(close)
    await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => vi.advanceTimersByTimeAsync(20))
    expect(container.querySelector('.gpu-warning-sheet')).toBeNull()
    expect(document.activeElement).toBe(fleetWarning)
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    const warningButton = container.querySelector<HTMLButtonElement>('[aria-label="查看系统 MEM 异常详情"]')!
    warningButton.focus()
    await act(async () => warningButton.click())
    expect(container.querySelector('.gpu-warning-sheet')?.textContent).toContain('系统内存')
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('概览')
    await act(async () => container.querySelector<HTMLButtonElement>('.gpu-warning-sheet footer button')!.click())
    await act(async () => vi.advanceTimersByTimeAsync(20))
    expect(document.activeElement).toBe(warningButton)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看 CPU 详情"]')!.click())
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('CPU')
  })

  it('shares active memory warnings between the bell, notification center and CPU card', async () => {
    useMemory(95)
    const settings = await api.getSettings()
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, idleNotificationsEnabled: false })
    await render()
    const bell = container.querySelector<HTMLButtonElement>('[aria-label="预约与通知"]')!
    expect(bell.querySelector('.notification-dot')).not.toBeNull()
    await act(async () => bell.click())
    expect(container.querySelector('.reservation-center-sheet h2')?.textContent).toContain('1 个预警')
    const row = container.querySelector('.reservation-row--warning')!
    expect(row.textContent).toContain('系统 MEM')
    expect(row.textContent).toContain('95.0%')
    const details = row.querySelector<HTMLButtonElement>('.reservation-warning-open')!
    await act(async () => details.click())
    expect(container.querySelector('.gpu-warning-sheet')?.textContent).toContain('90%')
    expect(container.querySelector('.gpu-warning-sheet')?.textContent).toContain('95.0%')
    const done = container.querySelector<HTMLButtonElement>('.gpu-warning-sheet footer button')!
    await act(async () => done.click())
    const ignore = row.querySelector<HTMLButtonElement>('.reservation-row__actions button')!
    await act(async () => ignore.click())
    expect(container.querySelector('.reservation-row--warning')).toBeNull()
    expect(bell.querySelector('.notification-dot')).toBeNull()
    expect(JSON.parse(localStorage.getItem(IGNORED_SYSTEM_MEMORY_KEY)!)).toEqual([server.id])
    await act(async () => container.querySelector<HTMLButtonElement>('.reservation-center-sheet footer button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    expect(container.querySelector('.cpu-overview-card.gpu-card--warning')).toBeNull()
    const config = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === '配置')!
    await act(async () => config.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.ignored-warning-row button')!.click())
    const overview = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent === '概览')!
    await act(async () => overview.click())
    const card = container.querySelector('.cpu-overview-card.gpu-card--warning')!
    expect(card).not.toBeNull()
    const warningButton = card.querySelector<HTMLButtonElement>('[aria-label="查看系统 MEM 异常详情"]')!
    await act(async () => warningButton.click())
    expect(container.querySelector('.gpu-warning-sheet')?.textContent).toContain('系统内存')
    useMemory(90)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新当前服务器"]')!.click())
    expect(container.querySelector('.gpu-warning-sheet')).toBeNull()
    expect(container.querySelector('.cpu-overview-card.gpu-card--warning')).toBeNull()
    expect(api.notify).not.toHaveBeenCalled()
  })

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
