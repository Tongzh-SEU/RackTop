// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import type { Server, Snapshot } from '../types/models'
import { IGNORED_NVIDIA_WARNINGS_STORAGE_KEY } from '../utils/nvidiaStatus'

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
  snapshot = { ...(await api.listLatestSnapshots())[0], timestamp: start / 1000, nvidiaSmi: 'missing', status: 'warning', gpus: [], processes: [] }
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
  vi.spyOn(api, 'collectServer').mockImplementation(collectSuccessfully)
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


async function click(text: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(text))
  expect(button, `button: ${text}`).toBeDefined()
  await act(async () => button!.click())
}

describe('fleet GPU warning ignore state (#108)', () => {
  it('hides the CPU-only warning after ignore, persists across reopening, and can restore it', async () => {
    await render()
    expect(container.querySelector('.fleet-no-gpu')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    await click('忽略此提醒')
    expect(container.textContent).toContain('可在服务器“配置”页恢复')
    await click('总览')
    expect(container.querySelector('.fleet-no-gpu')).toBeNull()
    expect(container.querySelector('.fleet-gpus')).toBeNull()
    expect(container.querySelector('.fleet-system')?.textContent).toContain('CPU')
    expect(JSON.parse(localStorage.getItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY)!)).toContain(server.id)

    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(container.querySelector('.fleet-no-gpu')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    const configTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '配置')!
    await act(async () => configTab.click())
    expect(container.querySelector('.ignored-warning-list h3')?.textContent).toBe('已忽略的提醒')
    await click('恢复提醒')
    await click('总览')
    expect(container.querySelector('.fleet-no-gpu')).not.toBeNull()
  })

  it('keeps the no-device notice for another server that has not been ignored', async () => {
    localStorage.setItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY, JSON.stringify(['another-server']))
    await render()
    expect(container.querySelector('.fleet-no-gpu')).not.toBeNull()
  })

  it('still displays unreadable GPU device rows when the warning was ignored', async () => {
    snapshot = { ...snapshot, nvidiaSmi: 'degraded', gpus: [{ uuid: 'unavailable-gpu', index: 0, name: 'Unavailable GPU 0' } as Snapshot['gpus'][number]] }
    localStorage.setItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY, JSON.stringify([server.id]))
    await render()
    expect(container.querySelector('.fleet-gpus')).not.toBeNull()
    expect(container.querySelector('.fleet-gpu-row--unavailable')?.textContent).toContain('无法读取')
  })
  it('restores a read failure and two GPU memory warnings independently', async () => {
    const gpus = [0, 1].map((index) => ({ index, uuid: `GPU-test-${index}`, name: 'NVIDIA A100', utilization: 0, memoryUtilization: 10, memoryUsedMb: 8192, memoryTotalMb: 81920, temperatureCelsius: 40, powerWatts: 50 }))
    snapshot = { ...snapshot, nvidiaSmi: 'degraded', gpus }
    vi.mocked(api.listLatestSnapshots).mockResolvedValue([snapshot])
    localStorage.setItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY, JSON.stringify([server.id]))
    const memoryIds = gpus.map((gpu) => `gpu-memory-stall:${server.id}:${gpu.uuid}`)
    localStorage.setItem('racktop.ignoredGpuMemoryStallWarnings.v1', JSON.stringify(memoryIds))
    localStorage.setItem('racktop.gpuMemoryStallSince.v1', JSON.stringify(Object.fromEntries(memoryIds.map((id) => [id, start / 1000 - 7200]))))
    await render()
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    const configTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '配置')!
    await act(async () => configTab.click())
    expect(container.querySelectorAll('.ignored-warning-row')).toHaveLength(3)
    await act(async () => container.querySelector<HTMLButtonElement>('.ignored-warning-row button')!.click())
    expect(container.querySelectorAll('.ignored-warning-row')).toHaveLength(2)
    expect(container.querySelector('.nvidia-warning')).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('.ignored-warning-row button')!.click())
    expect(container.querySelectorAll('.ignored-warning-row')).toHaveLength(1)
    expect(container.querySelector('.ignored-warning-row')?.textContent).toContain('GPU 1')
    expect(JSON.parse(localStorage.getItem('racktop.ignoredGpuMemoryStallWarnings.v1')!)).toEqual([memoryIds[1]])
  })

  it('automatically removes only recovered alerts and hides the list when all recover', async () => {
    const gpus = [0, 1].map((index) => ({ index, uuid: `GPU-recover-${index}`, name: 'NVIDIA A100', utilization: 0, memoryUtilization: 10, memoryUsedMb: 8192, memoryTotalMb: 81920, temperatureCelsius: 40, powerWatts: 50 }))
    snapshot = { ...snapshot, nvidiaSmi: 'degraded', gpus }
    vi.mocked(api.listLatestSnapshots).mockResolvedValue([snapshot])
    localStorage.setItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY, JSON.stringify([server.id]))
    const memoryIds = gpus.map((gpu) => `gpu-memory-stall:${server.id}:${gpu.uuid}`)
    localStorage.setItem('racktop.ignoredGpuMemoryStallWarnings.v1', JSON.stringify(memoryIds))
    localStorage.setItem('racktop.gpuMemoryStallSince.v1', JSON.stringify(Object.fromEntries(memoryIds.map((id) => [id, start / 1000 - 7200]))))
    await render()
    await act(async () => container.querySelector<HTMLButtonElement>('.fleet-card__header')!.click())
    const configTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === '配置')!
    await act(async () => configTab.click())
    expect(container.querySelectorAll('.ignored-warning-row')).toHaveLength(3)
    snapshot = { ...snapshot, nvidiaSmi: 'available', status: 'online', gpus: [ { ...gpus[0], utilization: 30 }, gpus[1] ] }
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新当前服务器"]')!.click())
    expect(container.querySelectorAll('.ignored-warning-row')).toHaveLength(1)
    expect(container.querySelector('.ignored-warning-row')?.textContent).toContain('GPU 1')
    expect(JSON.parse(localStorage.getItem(IGNORED_NVIDIA_WARNINGS_STORAGE_KEY)!)).toEqual([])
    snapshot = { ...snapshot, gpus: gpus.map((gpu) => ({ ...gpu, utilization: 30 })) }
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新当前服务器"]')!.click())
    expect(container.querySelector('.ignored-warning-list')).toBeNull()
    expect(JSON.parse(localStorage.getItem('racktop.ignoredGpuMemoryStallWarnings.v1')!)).toEqual([])
  })

})
