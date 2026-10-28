// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-notification', () => ({}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  Object.assign(window, { __TAURI_INTERNALS__: {} })
  invoke.mockReset().mockResolvedValue([])
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

describe('history request retention', () => {
  it('deduplicates a fresh result and releases its expiry timer without another request', async () => {
    const { api } = await import('./api')
    await api.getHistory('s', 30)
    await api.getHistory('s', 30)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.getTimerCount()).toBe(0)
    await api.getHistory('s', 30)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('bounds retained requests even during a burst of different keys', async () => {
    const { api } = await import('./api')
    for (let i = 0; i < 100; i++) await api.getHistory('s', i * 30)
    expect(vi.getTimerCount()).toBe(32)
    await api.getHistory('s', 0)
    expect(invoke).toHaveBeenCalledTimes(101)
    expect(vi.getTimerCount()).toBe(32)
  })
  it('does not let an old rejected request remove a replacement', async () => {
    let reject!: (error: Error) => void
    invoke.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const { api } = await import('./api')
    const old = api.getHistory('s', 30).catch(() => {})
    await vi.advanceTimersByTimeAsync(5000)
    await api.getHistory('s', 30)
    reject(new Error('old request failed'))
    await old
    await api.getHistory('s', 30)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })
})
