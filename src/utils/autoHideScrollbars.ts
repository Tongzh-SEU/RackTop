import type { AppPlatform } from './platform'

const SCROLL_AREAS = '.server-list, .workspace__scroll'
const HIDE_DELAY_MS = 900

export function enableAutoHideScrollbars(platform: AppPlatform, scope: Document = document) {
  if (platform !== 'windows' && platform !== 'linux') return () => {}
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  const hide = (element: HTMLElement) => {
    const timer = timers.get(element)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(element)
    delete element.dataset.scrollbarActive
  }
  const reveal = (element: HTMLElement) => {
    if (element.scrollHeight <= element.clientHeight) {
      hide(element)
      return
    }
    clearTimeout(timers.get(element))
    element.dataset.scrollbarActive = 'true'
    timers.set(element, setTimeout(() => {
      hide(element)
    }, HIDE_DELAY_MS))
  }
  const onScroll = (event: Event) => {
    if (event.target instanceof HTMLElement && event.target.matches(SCROLL_AREAS)) reveal(event.target)
  }
  const onPointerMove = (event: PointerEvent) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(SCROLL_AREAS) : null
    if (!element) return
    const bounds = element.getBoundingClientRect()
    if (event.clientX >= bounds.right - 12 && event.clientX <= bounds.right) reveal(element)
  }
  scope.addEventListener('scroll', onScroll, true)
  scope.addEventListener('pointermove', onPointerMove)
  return () => {
    scope.removeEventListener('scroll', onScroll, true)
    scope.removeEventListener('pointermove', onPointerMove)
    for (const element of timers.keys()) hide(element)
  }
}
