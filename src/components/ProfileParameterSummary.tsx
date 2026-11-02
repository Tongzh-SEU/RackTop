import { useLayoutEffect, useRef } from 'react'
import type { LaunchParameter } from '../utils/launchCommand'

export function ProfileParameterSummary({ parameters }: { parameters: LaunchParameter[] }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!parameters.length) return
    const element = root.current!
    const chips = Array.from(element.querySelectorAll<HTMLElement>(':scope > span'))
    const more = element.querySelector<HTMLElement>(':scope > small')!
    const measure = () => {
      const available = element.clientWidth
      const gap = parseFloat(getComputedStyle(element).columnGap)
      const widths = chips.map((chip) => {
        const style = getComputedStyle(chip)
        const limit = parseFloat(style.maxWidth)
        const textGap = parseFloat(style.columnGap)
        const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
          + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
        const key = chip.querySelector('code')!
        const value = chip.querySelector('em')
        // Computed widths stay in CSS pixels under app-shell scaling, like clientWidth.
        // Round natural text widths up so fractional pixels do not cause ellipsis.
        key.style.width = 'max-content'
        if (value) value.style.width = 'max-content'
        const keyWidth = Math.ceil(parseFloat(getComputedStyle(key).width))
        const valueWidth = value ? Math.ceil(parseFloat(getComputedStyle(value).width)) : 0
        const naturalWidth = keyWidth + valueWidth + (value ? textGap : 0) + inset
        if (naturalWidth > limit) {
          const contentWidth = limit - inset - (value ? textGap : 0)
          // Preserve the short side; split 60:40 only when both sides need truncation.
          const allocatedKey = value ? Math.min(keyWidth, Math.max(contentWidth - valueWidth, contentWidth * .6)) : contentWidth
          key.style.width = `${allocatedKey}px`
          if (value) value.style.width = `${contentWidth - allocatedKey}px`
        }
        return parseFloat(getComputedStyle(chip).width)
      })
      let count = chips.length
      for (; count >= 0; count--) {
        const remaining = parameters.length - count
        more.textContent = `+${remaining} 项`
        more.hidden = remaining === 0
        const used = widths.slice(0, count).reduce((sum, width) => sum + width, 0)
          + Math.max(0, count - 1) * gap + (remaining ? parseFloat(getComputedStyle(more).width) + (count ? gap : 0) : 0)
        if (used <= available || count === 0) break
      }
      chips.forEach((chip, index) => { chip.style.visibility = index < count ? 'visible' : 'hidden'; chip.style.position = index < count ? '' : 'absolute' })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [parameters])

  if (!parameters.length) return <div className="managed-profile-parameters"><small>未识别到可编辑超参数</small></div>
  return <div className="managed-profile-parameters" ref={root}>
    {parameters.slice(0, 4).map((parameter) => <span key={`${parameter.start}-${parameter.name}`} title={parameter.hasValue ? `${parameter.name} = ${parameter.value}` : parameter.name}>
      <code>{parameter.name}</code>{parameter.hasValue && <em>{parameter.value}</em>}
    </span>)}
    <small hidden />
  </div>
}
