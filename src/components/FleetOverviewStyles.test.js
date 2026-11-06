import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles.css', 'utf8')

describe('fleet resource bar colors', () => {
  it('uses the detail memory accent for fleet memory fill and CPU accent for CPU fill', () => {
    expect(styles).toContain('.fleet-gpu-row--idle, .fleet-gpu-row--active, .fleet-gpu-row--high, .fleet-gpu-row--critical { --memory-fill-color: color-mix(in srgb, var(--purple) 14%, transparent); }')
    expect(styles).toContain('.fleet-system b { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--blue); }')
    expect(styles).toContain('.metric-bar__fill--blue { background: var(--blue); }')
    expect(styles).toContain('.metric-bar__fill--purple { background: var(--purple); }')
  })
})
