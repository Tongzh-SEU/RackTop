import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { OnboardingChecklist, type OnboardingStep } from './OnboardingChecklist'

const steps: OnboardingStep[] = [
  { id: 'server', title: '添加第一台服务器', description: '连接 SSH 主机。', actionLabel: '添加服务器', completed: true, onAction: vi.fn() },
  { id: 'project', title: '创建项目', description: '保存代码目录。', actionLabel: '创建项目', completed: false, onAction: vi.fn() },
  { id: 'task', title: '启动第一个任务', description: '选择 GPU 并启动。', actionLabel: '启动任务', completed: false, onAction: vi.fn() },
]

const handlers = {
  onPreviewStepChange: vi.fn(),
  onCollapsedChange: vi.fn(),
  onDismiss: vi.fn(),
  onUseActualStateChange: vi.fn(),
}

describe('OnboardingChecklist', () => {
  it('shows only the next simulated action in new-user preview', () => {
    const markup = renderToStaticMarkup(<OnboardingChecklist {...handlers} steps={steps} previewStep={0} collapsed={false} dismissed={false} useActualState={false} showPreviewControls />)

    expect(markup).toContain('完成 0 / 3')
    expect(markup).toContain('下一步：添加第一台服务器')
    expect(markup).toContain('>添加服务器<')
    expect(markup).not.toContain('button--small">创建项目')
    expect(markup).not.toContain('button--small">启动任务')
  })

  it('can show completion derived from actual product state', () => {
    const markup = renderToStaticMarkup(<OnboardingChecklist {...handlers} steps={steps} previewStep={0} collapsed={false} dismissed={false} useActualState showPreviewControls />)

    expect(markup).toContain('完成 1 / 3')
    expect(markup).toContain('下一步：创建项目')
    expect(markup).toContain('>创建项目<')
    expect(markup).not.toContain('重置预览')
  })

  it('reduces a collapsed checklist to its summary header', () => {
    const markup = renderToStaticMarkup(<OnboardingChecklist {...handlers} steps={steps} previewStep={2} collapsed dismissed={false} useActualState={false} showPreviewControls />)

    expect(markup).toContain('is-collapsed')
    expect(markup).toContain('完成 2 / 3')
    expect(markup).not.toContain('onboarding-checklist__steps')
  })

  it('keeps preview-only controls out of the product experience', () => {
    const markup = renderToStaticMarkup(<OnboardingChecklist {...handlers} steps={steps} previewStep={0} collapsed={false} dismissed={false} useActualState />)

    expect(markup).not.toContain('预览新用户状态')
    expect(markup).not.toContain('查看实际状态')
    expect(markup).not.toContain('网页版交互预览')
  })
})
