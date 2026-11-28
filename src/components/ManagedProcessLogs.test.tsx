// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ManagedRun, Server } from '../types/models'
import { api } from '../services/api'
import { ManagedProcessView } from './ManagedProcessView'

vi.mock('../services/api', () => ({ api: { isDesktop: true, readManagedRunLog: vi.fn() } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const server: Server = {
  id: 'server', name: 'Server', host: 'localhost', port: 22, username: 'user', tags: [],
  samplingIntervalSeconds: 5, historyRetentionDays: 7, remoteHistoryEnabled: false,
  authMethod: 'sshAgent', status: 'online',
}
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const readLog = vi.mocked(api.readManagedRunLog)

beforeEach(async () => {
  vi.useFakeTimers()
  readLog.mockReset().mockResolvedValue('first line\nlatest line')
  const run: ManagedRun = {
    id: 'first', name: 'First task', profileId: null, projectId: null, serverId: server.id,
    gpuUuids: [], gpuIndices: [], workingDirectory: '/workspace', command: 'python train.py',
    pid: 123, logPath: '~/.racktop/runs/first/output.log',
    startedAt: Math.floor(Date.now() / 1_000), status: 'running',
  }
  localStorage.setItem('racktop.managedRuns.v1', JSON.stringify([run, { ...run, id: 'second', name: 'Second task', pid: 124 }]))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<ManagedProcessView servers={[server]} snapshots={{}} projects={[]}
    onOpenTerminal={() => {}} onNotice={() => {}} onRefreshServer={async () => {}} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.clear()
  vi.useRealTimers()
})

it('scrolls to the bottom after loading and polls without replacing the log with a loading message', async () => {
  let resolve!: (content: string) => void
  readLog.mockReturnValueOnce(new Promise<string>((done) => { resolve = done }))
  await act(async () => container.querySelector<HTMLButtonElement>('[title="查看日志"]')!.click())
  const pre = container.querySelector<HTMLPreElement>('.managed-log-inspector pre')!
  Object.defineProperty(pre, 'scrollHeight', { configurable: true, value: 1000 })
  expect(pre.textContent).toBe('正在读取远端日志…')
  await act(async () => resolve('first line\nlatest line'))
  expect(pre.scrollTop).toBe(1000)
  expect(readLog).toHaveBeenCalledWith(server.id, 'first')

  readLog.mockReturnValueOnce(new Promise<string>((done) => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(readLog).toHaveBeenCalledTimes(2)
  expect(pre.textContent).toBe('first line\nlatest line')
  Object.defineProperty(pre, 'scrollHeight', { value: 1200 })
  await act(async () => resolve('first line\nlatest line\nnew line'))
  expect(pre.textContent).toContain('new line')
  expect(pre.scrollTop).toBe(1200)
})

it.each([0, 1])('pauses follow on scroll up, resumes at the bottom, and resets when opening task %i', async (taskIndex) => {
  await act(async () => container.querySelector<HTMLButtonElement>('[title="查看日志"]')!.click())
  const pre = container.querySelector<HTMLPreElement>('.managed-log-inspector pre')!
  Object.defineProperty(pre, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(pre, 'clientHeight', { value: 200 })
  await act(async () => {
    pre.scrollTop = 500
    pre.dispatchEvent(new Event('scroll'))
  })
  readLog.mockResolvedValueOnce('new output while paused')
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(pre.textContent).toBe('new output while paused')
  expect(pre.scrollTop).toBe(500)

  await act(async () => {
    pre.scrollTop = 799.5
    pre.dispatchEvent(new Event('scroll'))
  })
  Object.defineProperty(pre, 'scrollHeight', { value: 1200 })
  readLog.mockResolvedValueOnce('new output after resuming')
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(pre.scrollTop).toBe(1200)

  await act(async () => {
    pre.scrollTop = 500
    pre.dispatchEvent(new Event('scroll'))
  })
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[title="查看日志"]')[taskIndex].click())
  expect(pre.scrollTop).toBe(1200)
})

it('keeps manual refresh working and stops polling when the inspector closes', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[title="查看日志"]')!.click())
  readLog.mockResolvedValueOnce('manually refreshed')
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.managed-log-inspector button')]
    .find((button) => button.textContent === '刷新日志')!.click())
  expect(container.querySelector('.managed-log-inspector pre')!.textContent).toBe('manually refreshed')
  expect(readLog).toHaveBeenCalledTimes(2)
  await act(async () => container.querySelector<HTMLButtonElement>('.managed-log-inspector [aria-label="关闭"]')!.click())
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
  expect(readLog).toHaveBeenCalledTimes(2)
  expect(container.querySelector('.managed-log-inspector')).toBeNull()
})

it('ignores an old task response after switching logs and stops polling on unmount', async () => {
  let resolve!: (content: string) => void
  readLog.mockReturnValueOnce(new Promise<string>((done) => { resolve = done }))
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[title="查看日志"]')[0].click())
  readLog.mockResolvedValue('second task output')
  await act(async () => container.querySelectorAll<HTMLButtonElement>('[title="查看日志"]')[1].click())
  await act(async () => resolve('stale first task output'))
  expect(container.querySelector('.managed-log-inspector pre')!.textContent).toBe('second task output')
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(readLog.mock.calls.map((call) => call[1])).toEqual(['first', 'second', 'second'])
  await act(async () => root.render(null))
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
  expect(readLog).toHaveBeenCalledTimes(3)
})

it('retries after a read error and handles an empty log', async () => {
  readLog.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce('')
  await act(async () => container.querySelector<HTMLButtonElement>('[title="查看日志"]')!.click())
  expect(container.querySelector('.managed-log-inspector pre')!.textContent).toBe('无法读取日志：connection lost')
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(container.querySelector('.managed-log-inspector pre')!.textContent).toBe('日志暂时为空。')
})
