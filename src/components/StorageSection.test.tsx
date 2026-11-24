// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StorageSection, wasDiskScanAttemptedToday } from './StorageSection'
import { api } from '../services/api'
import type { DiskMetric, DiskScanState } from '../types/models'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ''; localStorage.clear() })
const gb = 1024 ** 3
const disk = (mountPoint: string, total = 100, own: number | null = null): DiskMetric => ({ mountPoint, totalBytes: total * gb, usedBytes: 40 * gb, availableBytes: 50 * gb, currentUserUsedBytes: own == null ? null : own * gb })
const scan = (): DiskScanState => ({ serverId: 'one', queued: false, running: true, lastAttemptAt: 100, nextRefreshAt: 86500, retryAt: null, mounts: ['/a', '/b'].map((mountPoint) => ({ mountPoint, status: 'pending', result: null, collectedAt: null })) })
async function render(disks: DiskMetric[]) {
  const container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<StorageSection serverId="one" disks={disks} />))
  return container
}

it('renders df first, then updates only each completed du/df pair while preserving failed mount data', async () => {
  vi.useFakeTimers()
  let state = scan()
  vi.spyOn(api, 'getDiskScan').mockImplementation(async () => structuredClone(state))
  vi.spyOn(api, 'collectDiskUsage').mockImplementation(async () => structuredClone(state))
  const container = await render([disk('/a'), disk('/b')])
  expect(container.textContent).toContain('总计 100.0 GB')
  expect(container.textContent).toContain('剩余 50.0 GB')
  expect(container.textContent).toContain('你的 —')
  expect(container.textContent).toContain('正在更新')
  state.mounts[0] = { mountPoint: '/a', status: 'success', result: disk('/a', 200, 10), collectedAt: 110 }
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  const rows = container.querySelectorAll('.storage-waffle-row')
  expect(rows[0].textContent).toContain('总计 200.0 GB')
  expect(rows[0].textContent).toContain('你的 10.0 GB')
  expect(rows[1].textContent).toContain('总计 100.0 GB')
  state.mounts[1] = { mountPoint: '/b', status: 'permissionDenied', result: disk('/b', 150, 20), collectedAt: 90 }
  state.running = false
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  await act(async () => root.render(<StorageSection serverId="one" disks={[disk('/a', 999), disk('/b', 999)]} />))
  expect(rows[0].textContent).toContain('总计 200.0 GB')
  expect(rows[1].textContent).toContain('总计 150.0 GB')
  expect(rows[1].textContent).toContain('你的 20.0 GB')
  expect(container.textContent).toContain('权限不足')
  expect(container.querySelector('.storage-scan-meta')?.getAttribute('title')).toContain('/b：')
  await act(async () => root.render(<StorageSection serverId="one" disks={[disk('/a', 999)]} />))
  expect(container.textContent).toContain('总计 150.0 GB')
  expect(container.textContent).toContain('部分挂载点暂未采样')
})

it('manual refresh bypasses schedule, disables duplicates and promptly polls the new round', async () => {
  vi.useFakeTimers()
  let state = { ...scan(), running: false }
  state.lastAttemptAt = Math.floor(Date.now() / 1000)
  state.mounts.forEach((mount) => { mount.status = 'unrecognized' })
  vi.spyOn(api, 'getDiskScan').mockImplementation(async () => structuredClone(state))
  const collect = vi.spyOn(api, 'collectDiskUsage').mockImplementation(async (_id, _mounts, force) => {
    if (force) state = { ...state, running: true }
    return structuredClone(state)
  })
  const df = vi.spyOn(api, 'collectServer').mockResolvedValue({ disks: [disk('/a', 120), disk('/b')] } as Awaited<ReturnType<typeof api.collectServer>>)
  const container = await render([disk('/a'), disk('/b')])
  expect(container.textContent).toContain('未识别用户目录')
  const button = container.querySelector<HTMLButtonElement>('button')!
  await act(async () => button.click())
  expect(collect).toHaveBeenCalledWith('one', ['/a', '/b'], true)
  expect(df).toHaveBeenCalledWith('one', false, true, false)
  expect(df.mock.invocationCallOrder[0]).toBeLessThan(collect.mock.invocationCallOrder[0])
  expect(container.textContent).toContain('总计 120.0 GB')
  expect(button.disabled).toBe(true)
  const calls = collect.mock.calls.length
  await act(async () => button.click())
  expect(collect.mock.calls.length).toBe(calls)
  state.running = false
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(button.disabled).toBe(false)
})

it('starts one automatic scan per server on the first trend visit of the local day', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 24, 9, 0, 0))
  let stored: DiskScanState | null = null
  vi.spyOn(api, 'getDiskScan').mockImplementation(async () => structuredClone(stored))
  const fresh = disk('/fresh', 120)
  const df = vi.spyOn(api, 'collectServer').mockResolvedValue({ disks: [fresh] } as Awaited<ReturnType<typeof api.collectServer>>)
  const collect = vi.spyOn(api, 'collectDiskUsage').mockImplementation(async (serverId, mounts) => {
    stored = { serverId, queued: false, running: false, lastAttemptAt: Math.floor(Date.now() / 1000), nextRefreshAt: 0, retryAt: null, mounts: mounts.map((mountPoint) => ({ mountPoint, status: 'success', result: fresh, collectedAt: Math.floor(Date.now() / 1000) })) }
    return structuredClone(stored)
  })

  const container = await render([])
  expect(df).toHaveBeenCalledWith('one', false, true, false)
  expect(collect).toHaveBeenCalledWith('one', ['/fresh'], true)
  expect(container.textContent).toContain('总计 120.0 GB')

  await act(async () => root.unmount())
  root = createRoot(container)
  await act(async () => root.render(<StorageSection serverId="one" disks={[]} />))
  expect(df).toHaveBeenCalledTimes(1)
  expect(collect).toHaveBeenCalledTimes(1)
})

it('uses calendar days instead of a rolling twenty-four-hour window', () => {
  const now = new Date(2026, 10, 24, 0, 5, 0)
  const yesterday = new Date(2026, 10, 23, 23, 55, 0)
  const today = new Date(2026, 10, 24, 0, 1, 0)
  expect(wasDiskScanAttemptedToday(Math.floor(yesterday.getTime() / 1000), now.getTime())).toBe(false)
  expect(wasDiskScanAttemptedToday(Math.floor(today.getTime() / 1000), now.getTime())).toBe(true)
})
