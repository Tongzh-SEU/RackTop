import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ServerForm } from './ServerForm'

const handlers = { onClose: () => {}, onSave: async () => {} }

describe('ServerForm onboarding', () => {
  it('shows a dedicated SSH key guide before the first server form', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide />)
    expect(markup).toContain('推荐使用 SSH 密钥')
    expect(markup).toContain('RackTop 专用 Ed25519 密钥')
    expect(markup).toContain('复制快速配置')
    expect(markup).not.toContain('主机地址')
  })

  it('keeps the target-aware setup entry next to authentication when the guide is skipped', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} />)
    expect(markup).toContain('添加服务器')
    expect(markup).toContain('SSH 密钥快速配置')
    expect(markup).toContain('配置可独立撤销的 RackTop 专用密钥')
    expect(markup).toContain('key-guide__chevron')
    expect(markup.indexOf('SSH 密钥快速配置')).toBeLessThan(markup.indexOf('跳板机 ProxyJump'))
    expect(markup).not.toContain('第一次连接')
  })

  it('hides fixed per-server collection defaults from the form', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} />)

    expect(markup).not.toContain('此服务器采样间隔')
    expect(markup).not.toContain('本机历史保存')
    expect(markup).toContain('服务器远端缓存 30 天')
    expect(markup).toContain('同步到本机 90 天历史')
    expect(markup).toContain('type="checkbox" checked=""')
  })

  it('recommends SSH Agent when password authentication is selected', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} initial={{ authMethod: 'password' }} />)

    expect(markup).toContain('优先使用 SSH Agent')
    expect(markup).toContain('改用 SSH Agent（推荐）')
    expect(markup).not.toContain('使用 SSH 私钥（推荐）')
    expect(markup).not.toContain('SSH 密钥快速配置')
  })

  it('only shows quick setup for SSH Agent authentication', () => {
    const privateKeyMarkup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} initial={{ authMethod: 'privateKey' }} />)
    const sshConfigMarkup = renderToStaticMarkup(<ServerForm {...handlers} showGuide={false} initial={{ authMethod: 'sshConfig' }} />)

    expect(privateKeyMarkup).not.toContain('SSH 密钥快速配置')
    expect(sshConfigMarkup).not.toContain('SSH 密钥快速配置')
  })
})
