// @vitest-environment jsdom
// Navigation regressions reproduce #78 on upstream main.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { api } from '../services/api'
import type { Server, Snapshot } from '../types/models'

const harness = vi.hoisted(() => ({
  terminals: [] as Array<{ disposed: boolean; output: string; cols: number; rows: number; focus: ReturnType<typeof vi.fn>; write: (data: string | Uint8Array) => void }>,
  fits: [] as Array<ReturnType<typeof vi.fn>>,
  observers: [] as Array<{ callback: ResizeObserverCallback; disconnected: boolean }>,
  listeners: new Map<string, Set<(event: { payload: { sessionId: string; data?: string } }) => void>>(),
}))

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>()
  return { ...actual, api: { ...actual.api, isDesktop: true } }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}),
  setZoom: vi.fn(async () => {}), startDragging: vi.fn(async () => {}),
}) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, listener: (event: { payload: { sessionId: string; data?: string } }) => void) => {
    const listeners = harness.listeners.get(name) ?? new Set()
    listeners.add(listener)
    harness.listeners.set(name, listeners)
    return () => { listeners.delete(listener) }
  }),
}))
vi.mock('../services/appUpdater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/appUpdater')>()
  return { ...actual, checkDesktopAppUpdate: vi.fn(async () => null) }
})
vi.mock('./TrendChart', () => ({ TrendChart: () => null }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  fit = vi.fn()
  constructor() { harness.fits.push(this.fit) }
} }))
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80
  rows = 24
  disposed = false
  output = ''
  constructor() { harness.terminals.push(this) }
  loadAddon() {}
  open() {}
  focus = vi.fn()
  blur = vi.fn()
  getSelection() { return '' }
  onData() { return { dispose() {} } }
  write(data: string | Uint8Array) {
    this.output += typeof data === 'string' ? data : String.fromCharCode(...data)
  }
  dispose() { this.disposed = true }
} }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class implements ResizeObserver {
  disconnected = false
  constructor(public callback: ResizeObserverCallback) { harness.observers.push(this) }
  observe() {}
  unobserve() {}
  disconnect() { this.disconnected = true }
}
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
})

let root: ReturnType<typeof createRoot> | null
let container: HTMLDivElement
let servers: Server[]
let snapshots: Snapshot[]

beforeEach(async () => {
  localStorage.clear()
  harness.terminals.length = 0
  harness.fits.length = 0
  harness.observers.length = 0
  harness.listeners.clear()
  servers = (await api.listServers()).slice(0, 2).map(server => ({ ...server, remoteHistoryEnabled: false }))
  snapshots = (await api.listLatestSnapshots()).filter(snapshot => servers.some(server => server.id === snapshot.serverId))
  const settings = { ...(await api.getSettings()), idleNotificationsEnabled: false, reduceMotion: true, showAddServerGuide: false }
  vi.useFakeTimers()
  vi.spyOn(api, 'listServers').mockResolvedValue(servers)
  vi.spyOn(api, 'listLatestSnapshots').mockResolvedValue(snapshots)
  vi.spyOn(api, 'getSettings').mockResolvedValue(settings)
  vi.spyOn(api, 'listProjects').mockResolvedValue([])
  vi.spyOn(api, 'listIdleReservations').mockResolvedValue([])
  vi.spyOn(api, 'listServerNotificationSettings').mockResolvedValue([])
  vi.spyOn(api, 'getHistory').mockResolvedValue([])
  vi.spyOn(api, 'collectServer').mockImplementation(async serverId => snapshots.find(snapshot => snapshot.serverId === serverId)!)
  let nextSession = 0
  vi.spyOn(api, 'startTerminal').mockImplementation(async () => `session-${++nextSession}`)
  vi.spyOn(api, 'closeTerminal').mockResolvedValue()
  vi.spyOn(api, 'resizeTerminal').mockResolvedValue()
  vi.spyOn(api, 'deleteServer').mockResolvedValue({ remoteCleaned: true, cleanupPending: false, message: 'deleted' })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<App />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.clear()
})

async function clickMatching(selector: string, matches: (button: HTMLButtonElement) => boolean) {
  const button = [...container.querySelectorAll<HTMLButtonElement>(selector)].find(matches)
  expect(button, `Missing navigation button: ${selector}`).toBeDefined()
  await act(async () => button?.click())
}
const selectServer = (index: number) => clickMatching('.server-row', button => button.textContent?.includes(servers[index].name) ?? false)
const selectTab = (text: string) => clickMatching('.detail-page button', button => button.textContent === text)

async function openFirstTerminal() {
  await selectServer(0)
  await selectTab('终端')
  expect(api.startTerminal).toHaveBeenCalledTimes(1)
  expect(container.querySelector('.terminal-shell')?.textContent).toContain('已连接')
  await emitOutput('session-1', 'before-navigation')
}
async function emitOutput(sessionId: string, text: string) {
  await act(async () => {
    for (const listener of harness.listeners.get('terminal-output') ?? []) {
      listener({ payload: { sessionId, data: btoa(text) } })
    }
  })
}

describe('App terminal lifecycle', () => {
  it('does not connect before the terminal is first opened', async () => {
    expect(api.startTerminal).not.toHaveBeenCalled()
    await selectServer(0)
    expect(api.startTerminal).not.toHaveBeenCalled()
    await selectTab('终端')
    expect(api.startTerminal).toHaveBeenCalledExactlyOnceWith(servers[0].id, 80, 24, undefined, 'nvidia')
  })
  it('preserves the connected session and output across detail tabs', async () => {
    await openFirstTerminal()
    await selectTab('概览')
    await emitOutput('session-1', '-while-hidden')
    await selectTab('终端')
    expect(api.closeTerminal).not.toHaveBeenCalled()
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
    expect(harness.terminals[0].output).toContain('before-navigation-while-hidden')
  })
  it('preserves the session when visiting the fleet page and returning', async () => {
    await openFirstTerminal()
    await clickMatching('.primary-nav button', button => button.textContent?.startsWith('总览') ?? false)
    await selectServer(0)
    expect(api.closeTerminal).not.toHaveBeenCalled()
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
  })
  it('preserves independent sessions when switching servers and returning', async () => {
    await openFirstTerminal()
    await selectServer(1)
    await selectServer(0)
    expect(api.closeTerminal).not.toHaveBeenCalled()
    expect(api.startTerminal).toHaveBeenCalledTimes(2)
  })
  it('restarts exactly once when explicitly reconnecting', async () => {
    await openFirstTerminal()
    await clickMatching('button[aria-label="重新连接终端"]', () => true)
    expect(api.closeTerminal).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(api.startTerminal).toHaveBeenCalledTimes(2)
    expect(harness.terminals[0].disposed).toBe(true)
  })
  it('closes the connected session when the App unmounts', async () => {
    await openFirstTerminal()
    await act(async () => root?.unmount())
    root = null
    expect(api.closeTerminal).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(harness.terminals[0].disposed).toBe(true)
  })
  it('does not fit, resize or focus a hidden terminal and refits on return', async () => {
    await openFirstTerminal()
    await act(async () => vi.advanceTimersByTimeAsync(20))
    const terminal = harness.terminals[0]
    const focusCount = terminal.focus.mock.calls.length
    const fitCount = harness.fits[0].mock.calls.length
    vi.mocked(api.resizeTerminal).mockClear()
    await selectTab('概览')
    for (const observer of harness.observers.filter(observer => !observer.disconnected)) {
      observer.callback([], {} as ResizeObserver)
    }
    await act(async () => vi.advanceTimersByTimeAsync(20))
    expect(api.resizeTerminal).not.toHaveBeenCalled()
    expect(harness.fits[0]).toHaveBeenCalledTimes(fitCount)
    expect(terminal.focus).toHaveBeenCalledTimes(focusCount)
    terminal.cols = 132
    terminal.rows = 37
    await selectTab('终端')
    await act(async () => vi.advanceTimersByTimeAsync(20))
    expect(api.resizeTerminal).toHaveBeenCalledWith('session-1', 132, 37)
    expect(terminal.focus.mock.calls.length).toBeGreaterThan(focusCount)
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending connection while hidden and accepts its output without stealing focus', async () => {
    let resolveStart!: (sessionId: string) => void
    vi.mocked(api.startTerminal).mockReturnValueOnce(new Promise(resolve => { resolveStart = resolve }))
    await selectServer(0)
    await selectTab('终端')
    const terminal = harness.terminals[0]
    await selectTab('概览')
    terminal.focus.mockClear()
    vi.mocked(api.resizeTerminal).mockClear()
    await act(async () => resolveStart('late-session'))
    await emitOutput('late-session', 'output-while-hidden')
    expect(terminal.output).toContain('output-while-hidden')
    expect(terminal.focus).not.toHaveBeenCalled()
    expect(api.resizeTerminal).not.toHaveBeenCalled()
    expect(api.closeTerminal).not.toHaveBeenCalled()
    await selectTab('终端')
    await act(async () => vi.advanceTimersByTimeAsync(20))
    expect(api.resizeTerminal).toHaveBeenCalledWith('late-session', 80, 24)
    expect(api.startTerminal).toHaveBeenCalledTimes(1)
  })

  it('closes only the removed server session while preserving another open terminal', async () => {
    await openFirstTerminal()
    await selectServer(1)
    await selectServer(0)
    await selectTab('配置')
    await clickMatching('.danger-zone button', button => button.textContent === '删除')
    await clickMatching('.delete-server-sheet button', button => button.textContent === '删除全部数据')
    expect(api.deleteServer).toHaveBeenCalledWith(servers[0].id, false)
    expect(api.closeTerminal).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(harness.terminals[0].disposed).toBe(true)
    expect(harness.terminals[1].disposed).toBe(false)
    expect(api.startTerminal).toHaveBeenCalledTimes(2)
    await emitOutput('session-2', 'remaining-server')
    expect(harness.terminals[1].output).toContain('remaining-server')
  })

  it('closes a late connection after the App has unmounted', async () => {
    let resolveStart!: (sessionId: string) => void
    vi.mocked(api.startTerminal).mockReturnValueOnce(new Promise(resolve => { resolveStart = resolve }))
    await selectServer(0)
    await selectTab('终端')
    await act(async () => root?.unmount())
    root = null
    expect(api.closeTerminal).not.toHaveBeenCalled()
    await act(async () => resolveStart('late-session'))
    expect(api.closeTerminal).toHaveBeenCalledExactlyOnceWith('late-session')
    expect(harness.terminals[0].disposed).toBe(true)
    expect(harness.listeners.get('terminal-output')?.size).toBe(0)
  })

  it('closes a pending connection that completes after its server is removed', async () => {
    let resolveStart!: (sessionId: string) => void
    vi.mocked(api.startTerminal).mockReturnValueOnce(new Promise(resolve => { resolveStart = resolve }))
    await selectServer(0)
    await selectTab('终端')
    await selectTab('配置')
    await clickMatching('.danger-zone button', button => button.textContent === '删除')
    await clickMatching('.delete-server-sheet button', button => button.textContent === '删除全部数据')
    await act(async () => resolveStart('removed-session'))
    expect(api.closeTerminal).toHaveBeenCalledExactlyOnceWith('removed-session')
    expect(harness.terminals[0].disposed).toBe(true)
  })

})
