// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StorageSection } from './StorageSection'
import { api } from '../services/api'
import type { DiskMetric, DiskScanState } from '../types/models'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot>
afterEach(() => { act(() => root?.unmount()); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = '' })
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
  expect(df.mock.invocationCallOrder[0]).toBeLessThan(collect.mock.invocationCallOrder[1])
  expect(container.textContent).toContain('总计 120.0 GB')
  expect(button.disabled).toBe(true)
  const calls = collect.mock.calls.length
  await act(async () => button.click())
  expect(collect.mock.calls.length).toBe(calls)
  state.running = false
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(button.disabled).toBe(false)
})

it('keeps a cached network mount visible without scheduling it when the current snapshot only contains local disks', async () => {
  vi.useFakeTimers()
  const state: DiskScanState = {
    ...scan(), running: false,
    mounts: [
      { mountPoint: '/', status: 'success', result: disk('/', 100, 10), collectedAt: 110 },
      { mountPoint: '/net/shared', status: 'success', result: disk('/net/shared', 500, 20), collectedAt: 90 },
    ],
  }
  vi.spyOn(api, 'getDiskScan').mockResolvedValue(state)
  const collect = vi.spyOn(api, 'collectDiskUsage').mockResolvedValue(state)
  vi.spyOn(api, 'collectServer').mockResolvedValue({ disks: [disk('/')] } as Awaited<ReturnType<typeof api.collectServer>>)
  const container = await render([disk('/')])

  expect(collect).toHaveBeenCalledWith('one', ['/'])
  expect(container.textContent).toContain('/net/shared')
  expect(container.textContent).toContain('总计 500.0 GB')
  expect(container.textContent).toContain('部分挂载点暂未采样')
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
  expect(collect).toHaveBeenCalledWith('one', ['/'], true)
  expect(collect.mock.calls.every(([, mounts]) => mounts.length === 1 && mounts[0] === '/')).toBe(true)
})
