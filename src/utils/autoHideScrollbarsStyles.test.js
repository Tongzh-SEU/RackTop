import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles.css', 'utf8')

describe('scrollbar platform styles', () => {
  it('keeps macOS workspace styling and scopes custom sidebar thumbs to Windows/Linux', () => {
    expect(styles).toContain('.workspace__scroll::-webkit-scrollbar-thumb { min-height: 44px; border: 3px solid transparent; border-radius: 999px; background: color-mix(in srgb, var(--text-tertiary) 20%, transparent); background-clip: padding-box; }')
    expect(styles).toContain('.server-list { scrollbar-color: var(--scrollbar-thumb) transparent; }')

    const sidebarWebkitRules = [...styles.matchAll(/([^{}]*\.server-list[^{}]*::-webkit-scrollbar[^{}]*)\s*\{/g)]
    expect(sidebarWebkitRules.length).toBeGreaterThan(0)
    expect(sidebarWebkitRules.every(([selector]) => selector.includes(':root:is([data-platform="windows"], [data-platform="linux"])'))).toBe(true)

    const hiddenThumbRule = styles.match(/([^{}]+)\{[^{}]*--scrollbar-thumb:\s*transparent[^{}]*\}/)
    expect(hiddenThumbRule?.[1]?.trim()).toBe(':root:is([data-platform="windows"], [data-platform="linux"]) :is(.server-list, .workspace__scroll):not([data-scrollbar-active])')
  })

  it('keeps hover color aligned with the sidebar token on every platform', () => {
    expect(styles).toContain('.workspace__scroll:hover { scrollbar-color: var(--scrollbar-thumb) transparent; }')
    expect(styles).toContain('.workspace__scroll:hover::-webkit-scrollbar-thumb { background-color: var(--scrollbar-thumb); }')
  })

  it('uses the same Windows/Linux thumb color for the sidebar and workspace', () => {
    const thumbRule = styles.match(/:root:is\(\[data-platform="windows"\], \[data-platform="linux"\]\) \.server-list::-webkit-scrollbar-thumb,\s*:root:is\(\[data-platform="windows"\], \[data-platform="linux"\]\) \.workspace__scroll::-webkit-scrollbar-thumb\s*\{([^}]*)\}/)
    expect(thumbRule?.[1]).toContain('background: var(--scrollbar-thumb)')
    expect(styles).toContain(':root:is([data-platform="windows"], [data-platform="linux"]) :is(.server-list, .workspace__scroll) { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent; }')
  })
})
