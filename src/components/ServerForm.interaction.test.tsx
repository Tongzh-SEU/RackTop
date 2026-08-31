// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerForm } from './ServerForm'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

function enter(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ServerForm tag input', () => {
  it('commits English and Chinese commas and restores the last tag for Delete editing', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root?.render(<ServerForm initial={{ id: 'server', tags: [] }} showGuide={false} onClose={vi.fn()} onSave={vi.fn()} />))

    const input = document.querySelector<HTMLInputElement>('[aria-label="添加服务器标签"]')
    expect(input).not.toBeNull()
    if (!input) return

    enter(input, 'lab,')
    expect(document.querySelector('.server-tag-input__token')?.textContent).toBe('lab')
    expect(input.value).toBe('')

    enter(input, 'h100，')
    expect([...document.querySelectorAll('.server-tag-input__token')].map((token) => token.textContent)).toEqual(['lab', 'h100'])

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })))
    expect([...document.querySelectorAll('.server-tag-input__token')].map((token) => token.textContent)).toEqual(['lab'])
    expect(input.value).toBe('h100')
  })
})
