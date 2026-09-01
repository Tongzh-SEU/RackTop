import { describe, expect, it } from 'vitest'
import { isNewerVersion, shouldShowUpdateBadge } from './updateCheck'

describe('update checks', () => {
  it('compares semantic versions numerically', () => {
    expect(isNewerVersion('v1.25.0', '1.24.5')).toBe(true)
    expect(isNewerVersion('v1.24.5', '1.24.5')).toBe(false)
    expect(isNewerVersion('v1.9.0', '1.10.0')).toBe(false)
  })

  it('hides only the ignored release and reappears for a newer release', () => {
    expect(shouldShowUpdateBadge('1.25.0', undefined)).toBe(true)
    expect(shouldShowUpdateBadge('1.25.0', '1.25.0')).toBe(false)
    expect(shouldShowUpdateBadge('1.25.2', '1.25.1')).toBe(true)
  })
})
