// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Modal browser behavior', () => {
  let root: Root
  let mount: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="root"><div class="app-shell"><aside class="sidebar"><button id="origin">打开</button></aside><main class="workspace"><header class="topbar">工具栏</header><div class="workspace__scroll">内容</div></main></div></div>'
    mount = document.createElement('div')
    document.body.appendChild(mount)
    root = createRoot(mount)
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('portals into the workspace, isolates the background, and returns the close result', () => {
    const onClose = vi.fn()
    act(() => {
      root.render(<Modal onClose={onClose} label="确认"><section className="sheet"><button data-modal-close data-modal-result="confirm">确认</button></section></Modal>)
      vi.advanceTimersByTime(20)
    })

    const workspace = document.querySelector<HTMLElement>('.workspace')!
    const sidebar = document.querySelector<HTMLElement>('.sidebar')!
    const topbar = document.querySelector<HTMLElement>('.topbar')!
    const scroll = document.querySelector<HTMLElement>('.workspace__scroll')!
    const layer = workspace.querySelector<HTMLElement>('[data-modal-layer]')!
    expect(layer).not.toBeNull()
    expect(sidebar.inert).toBe(true)
    expect(topbar.inert).toBe(true)
    expect(scroll.inert).toBe(true)

    act(() => layer.querySelector<HTMLButtonElement>('[data-modal-result="confirm"]')!.click())
    expect(layer.classList.contains('is-closing')).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(150))
    expect(onClose).toHaveBeenCalledWith('confirm')
  })

  it('lets only the topmost nested modal handle Escape', () => {
    const closeOuter = vi.fn()
    const closeInner = vi.fn()
    act(() => {
      root.render(<><Modal onClose={closeOuter} label="外层"><section className="sheet"><button>外层</button></section></Modal><Modal onClose={closeInner} label="内层"><section className="sheet"><button>内层</button></section></Modal></>)
      vi.advanceTimersByTime(20)
    })

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(closeInner).toHaveBeenCalledTimes(1)
    expect(closeOuter).not.toHaveBeenCalled()
  })

  it('cycles focus within the topmost modal', () => {
    const offsetParent = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body)
    act(() => {
      root.render(<Modal onClose={() => undefined} label="焦点测试"><section className="sheet"><button id="first">第一项</button><button id="last">最后一项</button></section></Modal>)
      vi.advanceTimersByTime(20)
    })

    const first = document.querySelector<HTMLButtonElement>('#first')!
    const last = document.querySelector<HTMLButtonElement>('#last')!
    first.focus()
    expect(document.activeElement).toBe(first)
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })))
    expect(document.activeElement).toBe(last)
    offsetParent.mockRestore()
  })

  it('restores focus after the modal unmounts', () => {
    const origin = document.querySelector<HTMLButtonElement>('#origin')!
    origin.focus()
    act(() => {
      root.render(<Modal onClose={() => undefined} label="焦点恢复"><section className="sheet"><button>关闭</button></section></Modal>)
      vi.advanceTimersByTime(20)
    })
    document.querySelector<HTMLButtonElement>('.sheet button')!.focus()
    expect(document.activeElement).not.toBe(origin)

    act(() => root.render(null))
    expect(document.activeElement).toBe(origin)
  })
})
