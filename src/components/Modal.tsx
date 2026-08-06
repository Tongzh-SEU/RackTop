import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type ModalProps = {
  children: ReactNode
  onClose: (result?: string) => void
  labelledBy?: string
  label?: string
  role?: 'dialog' | 'alertdialog'
  className?: string
  closeOnScrim?: boolean
  closeOnEscape?: boolean
  initialFocusSelector?: string
}

export type ModalHandle = { close: (result?: string) => void }

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
const modalStack: symbol[] = []

type BackgroundState = { element: HTMLElement; inert: boolean; ariaHidden: string | null }

export const Modal = forwardRef<ModalHandle, ModalProps>(function Modal({ children, onClose, labelledBy, label, role = 'dialog', className = '', closeOnScrim = true, closeOnEscape = true, initialFocusSelector }, ref) {
  const [closing, setClosing] = useState(false)
  const layerRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const modalIdRef = useRef(Symbol('modal'))
  const scrimRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const modalId = modalIdRef.current
    modalStack.push(modalId)
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = document.getElementById('root')
    const workspace = scrimRef.current?.closest<HTMLElement>('.workspace')
    const ownScrim = scrimRef.current
    const backgroundElements = new Set<HTMLElement>()
    const sidebar = root?.querySelector<HTMLElement>('.sidebar')
    if (sidebar) backgroundElements.add(sidebar)
    if (workspace) {
      for (const child of workspace.children) {
        if (child !== ownScrim && child instanceof HTMLElement) backgroundElements.add(child)
      }
    } else if (root) backgroundElements.add(root)
    const backgroundStates: BackgroundState[] = [...backgroundElements].map((element) => ({ element, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }))
    for (const { element } of backgroundStates) {
      element.inert = true
      element.setAttribute('aria-hidden', 'true')
    }

    const focusInitial = () => {
      const layer = layerRef.current
      if (!layer) return
      const target: HTMLElement | null = (initialFocusSelector ? layer.querySelector<HTMLElement>(initialFocusSelector) : null) ?? layer.querySelector<HTMLElement>('[data-autofocus], input:not([type="hidden"]), button:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])')
      target?.focus({ preventScroll: true })
    }
    const frame = window.requestAnimationFrame(focusInitial)
    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== modalId) return
      if (event.key === 'Escape' && closeOnEscape && !closingRef.current) {
        event.preventDefault()
        closingRef.current = true
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(layerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        layerRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeInside = document.activeElement instanceof Node && layerRef.current?.contains(document.activeElement)
      if (!activeInside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown)
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
      const stackIndex = modalStack.lastIndexOf(modalId)
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1)
      for (const { element, inert, ariaHidden } of backgroundStates) {
        element.inert = inert
        if (ariaHidden === null) element.removeAttribute('aria-hidden')
        else element.setAttribute('aria-hidden', ariaHidden)
      }
      restoreFocusRef.current?.focus({ preventScroll: true })
    }
  }, [closeOnEscape, initialFocusSelector])

  function requestClose(result?: string) {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    closeTimerRef.current = window.setTimeout(() => onClose(result), 150)
  }

  useImperativeHandle(ref, () => ({ close: requestClose }))

  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, [data-modal-close]') : null
    const label = target?.textContent?.trim() ?? ''
    const closesModal = !!target && (target.matches('[data-modal-close], button[aria-label="关闭"]') || ['取消', '完成', '关闭', '保持阻止', '取消连接'].includes(label))
    if (!closesModal) return
    event.preventDefault()
    event.stopPropagation()
    requestClose(target?.dataset.modalResult)
  }

  const content = (
    <div ref={scrimRef} className={`scrim modal-scrim ${closing ? 'is-closing' : ''}`} data-modal-layer onPointerDown={(event) => { if (closeOnScrim && event.target === event.currentTarget) requestClose() }}>
      <div className="modal-positioner">
        <div ref={layerRef} className={`modal-focus-scope ${className}`} role={role} aria-modal="true" aria-labelledby={labelledBy} aria-label={label} tabIndex={-1} onClickCapture={handleClickCapture}>
          {children}
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? content : createPortal(content, document.querySelector('.workspace') ?? document.body)
})
