// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoHideScrollbars } from './autoHideScrollbars'

describe('desktop scrollbar visibility', () => {
  afterEach(() => vi.useRealTimers())

  it.each(['macos', 'web'] as const)('preserves native behavior on %s', (platform) => {
    const remove = enableAutoHideScrollbars(platform)
    const list = document.createElement('div')
    list.className = 'server-list'
    document.body.appendChild(list)
    list.dispatchEvent(new Event('scroll'))
    expect(list.dataset.scrollbarActive).toBeUndefined()
    remove()
    list.remove()
  })

  it.each(['windows', 'linux'] as const)('reveals and hides both sidebar and workspace bars on %s', (platform) => {
    vi.useFakeTimers()
    const remove = enableAutoHideScrollbars(platform)
    const list = document.createElement('div')
    list.className = 'server-list'
    const workspace = document.createElement('div')
    workspace.className = 'workspace__scroll'
    document.body.append(list, workspace)
    Object.defineProperties(list, { scrollHeight: { value: 500 }, clientHeight: { value: 300 } })
    Object.defineProperties(workspace, { scrollHeight: { value: 500 }, clientHeight: { value: 300 } })
    list.dispatchEvent(new Event('scroll'))
    workspace.dispatchEvent(new Event('scroll'))
    expect(list.dataset.scrollbarActive).toBe('true')
    expect(workspace.dataset.scrollbarActive).toBe('true')
    vi.advanceTimersByTime(900)
    expect(list.dataset.scrollbarActive).toBeUndefined()
    expect(workspace.dataset.scrollbarActive).toBeUndefined()
    remove()
    list.remove()
    workspace.remove()
  })

  it.each(['windows', 'linux'] as const)('only reveals overflowing content near the scrollbar on %s', (platform) => {
    vi.useFakeTimers()
    const remove = enableAutoHideScrollbars(platform)
    const list = document.createElement('div')
    list.className = 'server-list'
    document.body.appendChild(list)
    let contentHeight = 200
    Object.defineProperties(list, {
      scrollHeight: { get: () => contentHeight },
      clientHeight: { value: 300 },
      getBoundingClientRect: { value: () => ({ right: 300 }) },
    })
    list.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 295 }))
    list.dispatchEvent(new Event('scroll'))
    expect(list.dataset.scrollbarActive).toBeUndefined()

    contentHeight = 500
    list.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 150 }))
    expect(list.dataset.scrollbarActive).toBeUndefined()
    list.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 295 }))
    expect(list.dataset.scrollbarActive).toBe('true')
    vi.advanceTimersByTime(800)
    list.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(800)
    expect(list.dataset.scrollbarActive).toBe('true')

    remove()
    expect(list.dataset.scrollbarActive).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    list.remove()
  })

  it.each(['windows', 'linux'] as const)('hides immediately when a visible list stops overflowing on %s', (platform) => {
    vi.useFakeTimers()
    const remove = enableAutoHideScrollbars(platform)
    const list = document.createElement('div')
    list.className = 'server-list'
    document.body.appendChild(list)
    let contentHeight = 500
    Object.defineProperties(list, {
      scrollHeight: { get: () => contentHeight },
      clientHeight: { value: 300 },
      getBoundingClientRect: { value: () => ({ right: 300 }) },
    })
    list.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 295 }))
    expect(list.dataset.scrollbarActive).toBe('true')

    contentHeight = 250
    list.dispatchEvent(new Event('scroll'))
    expect(list.dataset.scrollbarActive).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
    remove()
    list.remove()
  })
})
