import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps terminal and tabs aligned and compensates xterm pointer coordinates', () => {
  const styles = readFileSync('src/styles.css', 'utf8')
  expect(styles).toMatch(/\.workspace__scroll\s*\{[^}]*overflow-y: auto;/)
  expect(styles).toMatch(/\.gpu-grid, \.project-grid\s*\{\s*justify-content:\s*start;/)
  expect(styles).toMatch(/:is\(\.detail-page\.server-detail-page, \.terminal-workspace\)\s*\{\s*width:\s*min\(var\(--card-page-width, 1180px\), calc\(100% - var\(--card-page-inset, 52px\)\)\);/)
  expect(styles).toMatch(/:is\(\.detail-page\.server-detail-page, \.terminal-workspace\)\s*\{\s*width:\s*min\(1180px, calc\(100% - 52px\)\);/)
  expect(styles).toMatch(/\.detail-tabs\s*\{[^}]*min-width: 0;[^}]*overflow-x: auto;/)
  expect(styles).not.toContain('.detail-page:has(.overview-stack)')
  expect(styles).toMatch(/\.server-detail-page :is\([^}]+\.usage-waffle-list\)\s*\{\s*justify-content:\s*start;/)
  expect(styles).toMatch(/\.terminal-surface\s*\{[^}]*width: calc\(100% \* var\(--ui-zoom, 1\)\);[^}]*height: calc\(100% \* var\(--ui-zoom, 1\)\);[^}]*transform: scale\(var\(--ui-zoom-inverse, 1\)\);/)
})
