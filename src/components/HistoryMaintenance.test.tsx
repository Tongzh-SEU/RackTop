// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryView } from '../App'
import { api } from '../services/api'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(api, 'getHistoryHeatmap').mockResolvedValue([])
  vi.spyOn(api, 'getUsageDistribution').mockResolvedValue({ users: [], coveredDays: 0, requestedDays: 30, coverageGpuSeconds: 0 })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function render() {
  const server = (await api.listServers())[0]
  const snapshot = (await api.listLatestSnapshots())[0]
  await act(async () => root.render(<HistoryView server={server} snapshot={snapshot} />))
}
function expectNoQueries() {
  expect(api.getHistoryHeatmap).not.toHaveBeenCalled()
  expect(api.getUsageDistribution).not.toHaveBeenCalled()
}

describe('history maintenance gate', () => {
  it('does not query until the initial status resolves', async () => {
    let resolve!: (value: boolean) => void
    vi.spyOn(api, 'isStorageMaintenanceActive').mockImplementation(() => new Promise((done) => { resolve = done }))
    await render()
    expectNoQueries()
    expect(container.textContent).toContain('正在检查历史数据状态')
    await act(async () => resolve(false))
    expect(api.getHistoryHeatmap).toHaveBeenCalledTimes(1)
    expect(api.getUsageDistribution).toHaveBeenCalledTimes(1)
  })

  it('blocks throughout maintenance and refreshes immediately when it ends', async () => {
    const status = vi.spyOn(api, 'isStorageMaintenanceActive').mockResolvedValue(true)
    await render()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expectNoQueries()
    expect(container.textContent).toContain('历史数据维护中，请稍等')
    status.mockResolvedValue(false)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.getHistoryHeatmap).toHaveBeenCalledTimes(1)
    expect(api.getUsageDistribution).toHaveBeenCalledTimes(1)
    status.mockResolvedValue(true)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    status.mockResolvedValue(false)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.getHistoryHeatmap).toHaveBeenCalledTimes(2)
    expect(api.getUsageDistribution).toHaveBeenCalledTimes(2)
  })

  it('fails closed on status errors and automatically retries', async () => {
    const status = vi.spyOn(api, 'isStorageMaintenanceActive').mockRejectedValue(new Error('offline'))
    await render()
    expectNoQueries()
    expect(container.textContent).toContain('正在自动重试')
    status.mockResolvedValue(false)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(api.getUsageDistribution).toHaveBeenCalledTimes(1)
  })

  it('does not continue polling or load after leaving the page', async () => {
    const status = vi.spyOn(api, 'isStorageMaintenanceActive').mockResolvedValue(true)
    await render()
    await act(async () => root.render(null))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(status).toHaveBeenCalledTimes(1)
    expectNoQueries()
  })
})
