import { describe, expect, it } from 'vitest'
import { canDisplayServerDetails, serverStatusAfterFailure, shouldShowConnectingOnAttempt } from './connectionStatus'

describe('connection status', () => {
  it('keeps initial retry waits blue and turns red after three consecutive failures', () => {
    expect(serverStatusAfterFailure(1)).toBe('connecting')
    expect(serverStatusAfterFailure(2)).toBe('connecting')
    expect(serverStatusAfterFailure(3)).toBe('offline')
  })

  it('shows manual attempts as connecting even after the offline threshold', () => {
    expect(shouldShowConnectingOnAttempt(false, true, 3)).toBe(true)
    expect(shouldShowConnectingOnAttempt(true, true, 3)).toBe(false)
  })

  it('keeps a healthy server green during quiet background sampling', () => {
    expect(shouldShowConnectingOnAttempt(true, true, 0)).toBe(false)
    expect(shouldShowConnectingOnAttempt(true, true, 1)).toBe(true)
    expect(shouldShowConnectingOnAttempt(true, false, 0)).toBe(true)
  })

  it('only displays cached server details while the connection is usable', () => {
    expect(canDisplayServerDetails('online')).toBe(true)
    expect(canDisplayServerDetails('warning')).toBe(true)
    expect(canDisplayServerDetails('connecting')).toBe(false)
    expect(canDisplayServerDetails('offline')).toBe(false)
    expect(canDisplayServerDetails('unknown')).toBe(false)
  })
})
