// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileParameterSummary } from './ProfileParameterSummary'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('profile parameter summary', () => {
  it('provides full hover text including empty values and flag parameters', () => {
    const markup = renderToStaticMarkup(<ProfileParameterSummary parameters={[
      { name: '--model', value: '/long/model/path', hasValue: true, start: 0, end: 1 },
      { name: '--flag', value: '', hasValue: false, start: 2, end: 3 },
      { name: '--empty', value: '', hasValue: true, start: 4, end: 5 },
    ]} />)
    expect(markup).toContain('title="--model = /long/model/path"')
    expect(markup).toContain('title="--flag"')
    expect(markup).toContain('title="--empty = "')
  })

  it('shows the existing empty hint', () => {
    expect(renderToStaticMarkup(<ProfileParameterSummary parameters={[]} />)).toContain('未识别到可编辑超参数')
  })
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([0.8, 1, 1.2])('allocates text widths and updates the hidden count at %s zoom', (zoom) => {
  let width = 1000
  let resize = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  const getStyle = globalThis.getComputedStyle
  // Layout widths stay in CSS pixels while bounding rectangles include app zoom.
  const layoutWidth = (element: HTMLElement): number => {
    if (element.matches('.managed-profile-parameters > span')) {
      const style = getStyle(element)
      const children = Array.from(element.children) as HTMLElement[]
      const textWidth = children.reduce((sum, child) => sum + (child.style.width === 'max-content'
        ? layoutWidth(child) : parseFloat(child.style.width)), 0)
      return Math.min(parseFloat(style.maxWidth), textWidth + parseFloat(style.columnGap)
        + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth))
    }
    return element.textContent === '--runner' ? 40.4 : element.textContent === 'pooling' ? 30.4
      : element.matches('code, em') ? (element.textContent!.includes('long') ? 300 : 10) : 35
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: layoutWidth(this) * zoom } as DOMRect
  })
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
    const style = getStyle(element)
    Object.defineProperty(style, 'width', { value: `${layoutWidth(element as HTMLElement)}px`, configurable: true })
    return style
  })
  const stylesheet = document.createElement('style')
  // jsdom does not expand gap shorthand into computed columnGap as browsers do.
  stylesheet.textContent = '.managed-profile-parameters { column-gap: 5px; } .managed-profile-parameters > span { max-width: 220px; column-gap: 5px; padding: 3px 6px; border: 1px solid; }'
  document.head.append(stylesheet)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const parameters = [
    ['--long-key', '8'], ['--k', 'long-value'], ['--long-key', 'long-value'], ['--runner', 'pooling'], ['--extra', '1'],
  ].map(([name, value], start) => ({ name: name!, value: value ?? '', hasValue: value !== null, start, end: start + 1 }))
  try {
    act(() => root.render(<ProfileParameterSummary parameters={parameters} />))
    const chips = Array.from(host.querySelectorAll('span'))
    const keyWidth = (index: number) => parseFloat(chips[index].querySelector('code')!.style.width)
    const valueWidth = (index: number) => parseFloat(chips[index].querySelector('em')!.style.width)
    expect([keyWidth(0), valueWidth(0)]).toEqual([191, 10])
    expect([keyWidth(1), valueWidth(1)]).toEqual([10, 191])
    expect(keyWidth(2)).toBeCloseTo(120.6)
    expect(valueWidth(2)).toBeCloseTo(80.4)
    // Both short texts must fit even when their natural widths have fractional pixels.
    expect(chips[3].querySelector('code')!.style.width).toBe('max-content')
    expect(chips[3].querySelector('em')!.style.width).toBe('max-content')
    expect(chips[3].style.width).toBe('')
    expect(host.querySelector('small')!.textContent).toBe('+1 项')
    width = 500
    act(() => resize())
    expect(chips.filter((chip) => chip.style.visibility === 'visible')).toHaveLength(2)
    expect(host.querySelector('small')!.textContent).toBe('+3 项')
    width = 80
    act(() => resize())
    expect(chips.filter((chip) => chip.style.visibility === 'visible')).toHaveLength(0)
    expect(host.querySelector('small')!.textContent).toBe('+5 项')
    expect(chips[3].style.width).toBe('')
    width = 1000
    act(() => resize())
    expect(chips.filter((chip) => chip.style.visibility === 'visible')).toHaveLength(4)
    expect(host.querySelector('small')!.textContent).toBe('+1 项')
    // Style-only changes must drive allocation and counting without matching JS constants.
    host.firstElementChild!.setAttribute('style', 'column-gap: 11px')
    chips.forEach((chip) => { chip.style.cssText = 'max-width: 260px; column-gap: 9px; padding: 3px 8px; border: 2px solid' })
    width = 570
    act(() => resize())
    expect([keyWidth(0), valueWidth(0)]).toEqual([221, 10])
    expect([keyWidth(1), valueWidth(1)]).toEqual([10, 221])
    expect(chips.filter((chip) => chip.style.visibility === 'visible')).toHaveLength(1)
    expect(host.querySelector('small')!.textContent).toBe('+4 项')
  } finally {
    act(() => root.unmount())
    host.remove()
    stylesheet.remove()
  }
  expect(disconnect).toHaveBeenCalledOnce()
})
