import { ArrowRight, Workflow, X } from 'lucide-react'

export interface WorkflowContextItem {
  label: string
  value: string
}

export function WorkflowContextBar({ title = '当前任务准备', items, actionLabel, onAction, onClear }: {
  title?: string
  items: WorkflowContextItem[]
  actionLabel: string
  onAction: () => void
  onClear: () => void
}) {
  return <section className="workflow-bar" aria-label={title}>
    <div className="workflow-path">
      <Workflow size={16} />
      {items.map((item, index) => <div className="workflow-path__item" key={`${item.label}-${index}`}>
        {index > 0 && <ArrowRight className="workflow-path__arrow" size={13} />}
        <span><small>{index === 0 ? title : item.label}</small><strong>{item.value}</strong></span>
      </div>)}
    </div>
    <div><button onClick={onAction}>{actionLabel}</button><button className="icon-button" onClick={onClear} aria-label={`清除${title}`}><X size={15} /></button></div>
  </section>
}
