import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Modal } from './Modal'

describe('Modal', () => {
  it('renders an accessible dialog shell during SSR', () => {
    const markup = renderToStaticMarkup(<Modal onClose={() => {}} label="测试弹窗"><button data-modal-close>关闭</button></Modal>)
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('data-modal-close')
  })
})
