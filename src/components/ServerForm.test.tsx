import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ServerForm } from './ServerForm'

const handlers = { onClose: () => {}, onSave: async () => {} }

describe('ServerForm onboarding', () => {
  it('shows a dedicated SSH key guide before the first server form', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide />)
    expect(markup).toContain('推荐使用 SSH 密钥')
    expect(markup).toContain('Ed25519 密钥 + SSH Agent')
    expect(markup).toContain('复制快速配置')
    expect(markup).not.toContain('主机地址')
  })

  it('keeps the target-aware setup entry next to authentication when the guide is skipped', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} />)
    expect(markup).toContain('添加服务器')
    expect(markup).toContain('SSH 密钥快速配置')
    expect(markup).toContain('生成并复制当前服务器的免密登录命令')
    expect(markup).toContain('key-guide__chevron')
    expect(markup.indexOf('SSH 密钥快速配置')).toBeLessThan(markup.indexOf('跳板机 ProxyJump'))
    expect(markup).not.toContain('第一次连接')
  })

  it('defaults new servers to 90 local days with 30-day remote retention enabled', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} />)

    expect(markup).toContain('<option value="90" selected="">90 天</option>')
    expect(markup).toContain('远端持续保存 30 天')
    expect(markup).toContain('type="checkbox" checked=""')
  })
})
