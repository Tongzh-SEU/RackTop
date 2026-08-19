import { Check, CheckCircle2, ChevronRight, Circle, RotateCcw, X } from 'lucide-react'

export type OnboardingStep = {
  id: string
  title: string
  description: string
  actionLabel: string
  completed: boolean
  onAction: () => void
}

export function OnboardingChecklist({ steps, previewStep, collapsed, dismissed, useActualState, showPreviewControls = false, onPreviewStepChange, onCollapsedChange, onDismiss, onUseActualStateChange }: {
  steps: OnboardingStep[]
  previewStep: number
  collapsed: boolean
  dismissed: boolean
  useActualState: boolean
  showPreviewControls?: boolean
  onPreviewStepChange: (step: number) => void
  onCollapsedChange: (collapsed: boolean) => void
  onDismiss: () => void
  onUseActualStateChange: (actual: boolean) => void
}) {
  if (dismissed) return null

  const complete = useActualState ? steps.filter((step) => step.completed).length : Math.min(previewStep, steps.length)
  const visibleSteps = steps.map((step, index) => ({ ...step, completed: useActualState ? step.completed : index < previewStep }))
  const currentIndex = visibleSteps.findIndex((step) => !step.completed)
  const allComplete = currentIndex < 0

  function runStep(index: number) {
    if (!useActualState) onPreviewStepChange(Math.max(previewStep, index + 1))
    steps[index].onAction()
  }

  return (
    <section className={`onboarding-checklist${collapsed ? ' is-collapsed' : ''}`} aria-labelledby="onboarding-title">
      <header>
        <button className="onboarding-checklist__heading" onClick={() => onCollapsedChange(!collapsed)} aria-expanded={!collapsed}>
          <span className="onboarding-checklist__mark"><Check size={15} /></span>
          <span><strong id="onboarding-title">开始使用 RackTop</strong><small>{allComplete ? '基础工作流已就绪' : `完成 ${complete} / ${steps.length} · 下一步：${visibleSteps[currentIndex].title}`}</small></span>
          <ChevronRight className="onboarding-checklist__chevron" size={15} />
        </button>
        <div className="onboarding-checklist__tools">
          {showPreviewControls && <button className="button button--secondary button--small" onClick={() => onUseActualStateChange(!useActualState)}>{useActualState ? '预览新用户状态' : '查看实际状态'}</button>}
          <button className="icon-button" onClick={onDismiss} title="关闭引导" aria-label="关闭新手引导"><X size={14} /></button>
        </div>
      </header>
      {!collapsed && <>
        <div className="onboarding-checklist__progress" aria-hidden="true"><span style={{ width: `${complete / steps.length * 100}%` }} /></div>
        <div className="onboarding-checklist__steps">
          {visibleSteps.map((step, index) => {
            const current = index === currentIndex
            return <div className={`onboarding-step${step.completed ? ' is-complete' : ''}${current ? ' is-current' : ''}`} key={step.id}>
              <span className="onboarding-step__status">{step.completed ? <CheckCircle2 size={17} /> : <Circle size={17} />}</span>
              <span className="onboarding-step__copy"><strong>{step.title}</strong><small>{step.description}</small></span>
              {current && <button className="button button--secondary button--small" onClick={() => runStep(index)}>{step.actionLabel}<ChevronRight size={13} /></button>}
            </div>
          })}
        </div>
        {showPreviewControls && !useActualState && previewStep > 0 && <footer><span>网页版交互预览，不会改动实际完成状态</span><button onClick={() => onPreviewStepChange(0)}><RotateCcw size={12} />重置预览</button></footer>}
      </>}
    </section>
  )
}
