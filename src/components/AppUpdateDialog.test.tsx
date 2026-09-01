// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppUpdateDialog } from './AppUpdateDialog'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

function renderDialog(phase: 'downloading' | 'installing' | 'error') {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const handlers = { onClose: vi.fn(), onRetry: vi.fn(), onManualDownload: vi.fn() }
  act(() => root?.render(<AppUpdateDialog
    state={{ phase, version: '1.25.4', downloadedBytes: 7_000_000, totalBytes: 12_000_000, error: phase === 'error' ? '网络连接失败' : undefined }}
    {...handlers}
  />))
  return { container, handlers }
}

describe('AppUpdateDialog', () => {
  it('shows compact progress and no cancellation control while active', () => {
    const { container } = renderDialog('downloading')
    expect(container.textContent).toContain('正在下载 RackTop 1.25.4')
    expect(container.textContent).toContain('MB /')
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('58')
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps installation non-cancellable', () => {
    const { container } = renderDialog('installing')
    expect(container.textContent).toContain('正在安装 RackTop 1.25.4')
    expect(container.querySelector('button')).toBeNull()
  })

  it('offers close, retry, and manual download only after failure', () => {
    const { container, handlers } = renderDialog('error')
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent).join(' ')).toContain('手动下载')
    expect(buttons.map((button) => button.textContent).join(' ')).toContain('重试')
    act(() => buttons.find((button) => button.textContent?.includes('手动下载'))?.click())
    act(() => buttons.find((button) => button.textContent?.includes('重试'))?.click())
    expect(handlers.onManualDownload).toHaveBeenCalledOnce()
    expect(handlers.onRetry).toHaveBeenCalledOnce()
  })
})
