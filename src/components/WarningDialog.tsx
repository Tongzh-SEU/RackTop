import { useEffect, useId, useRef, type ReactNode } from 'react'
import { AlertCircle, X } from 'lucide-react'

export function WarningDialog({ eyebrow, title, summary, description, children, onClose }: { eyebrow: string; title: string; summary: string; description: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId()
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
      if (event.key !== 'Tab') return
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={dialog} className="sheet gpu-warning-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="sheet__header"><div><p className="eyebrow">{eyebrow}</p><h2 id={titleId}>{title}</h2></div><button autoFocus className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="gpu-warning-body">
        <span className="gpu-warning-body__icon"><AlertCircle size={23} /></span>
        <div><strong>{summary}</strong><p>{description}</p></div>
        {children}
      </div>
      <footer className="sheet__footer"><button className="button button--primary" onClick={onClose}>完成</button></footer>
    </section>
  </div>
}
