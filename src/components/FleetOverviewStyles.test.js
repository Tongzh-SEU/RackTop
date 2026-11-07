import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/styles.css', 'utf8')

describe('fleet resource bar colors', () => {
  it('uses state colors for fleet memory fill and the detail accent for CPU fill', () => {
    expect(styles).toContain('.fleet-gpu-row--idle { --memory-fill-color: transparent; }')
    expect(styles).toContain('.fleet-gpu-row--active { --memory-fill-color: color-mix(in srgb, var(--blue) 8%, transparent); }')
    expect(styles).toContain('.fleet-gpu-row--high { --memory-fill-color: color-mix(in srgb, var(--orange) 9%, transparent); }')
    expect(styles).toContain('.fleet-gpu-row--critical { --memory-fill-color: color-mix(in srgb, var(--red) 10%, transparent); }')
    expect(styles).toContain('.fleet-system b { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--blue); }')
    expect(styles).toContain('.metric-bar__fill--blue { background: var(--blue); }')
    expect(styles).toContain('.metric-bar__fill--purple { background: var(--purple); }')
  })
})
