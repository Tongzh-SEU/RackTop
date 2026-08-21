import { describe, expect, it } from 'vitest'
import { isNewerVersion, shouldCheckForUpdates, shouldShowUpdateBadge, UPDATE_CHECK_INTERVAL_MS } from './updateCheck'

describe('update checks', () => {
  it('compares semantic versions numerically', () => {
    expect(isNewerVersion('v1.25.0', '1.24.5')).toBe(true)
    expect(isNewerVersion('v1.24.5', '1.24.5')).toBe(false)
    expect(isNewerVersion('v1.9.0', '1.10.0')).toBe(false)
  })

  it('checks at most once per 24 hours automatically', () => {
    const now = 1_000_000_000
    expect(shouldCheckForUpdates(now - UPDATE_CHECK_INTERVAL_MS + 1, now)).toBe(false)
    expect(shouldCheckForUpdates(now - UPDATE_CHECK_INTERVAL_MS, now)).toBe(true)
  })

  it('hides only the ignored release and reappears for a newer release', () => {
    expect(shouldShowUpdateBadge('1.25.0', undefined)).toBe(true)
    expect(shouldShowUpdateBadge('1.25.0', '1.25.0')).toBe(false)
    expect(shouldShowUpdateBadge('1.26.0', '1.25.0')).toBe(true)
  })
})
