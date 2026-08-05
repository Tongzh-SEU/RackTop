import { describe, expect, it } from 'vitest'
import { canOfferNvidiaDriverInstall, displayedNvidiaServerStatus, nvidiaIssueGuidance, nvidiaIssueTitle, parseIgnoredNvidiaWarningIds } from './nvidiaStatus'

describe('NVIDIA issue presentation', () => {
  it('keeps partial GPU failures separate from missing drivers', () => {
    expect(nvidiaIssueTitle('degraded')).toBe('部分 NVIDIA GPU 无法监控')
    expect(nvidiaIssueGuidance('degraded')).toContain('其余可访问 GPU 会继续监控')
    expect(canOfferNvidiaDriverInstall('degraded')).toBe(false)
    expect(canOfferNvidiaDriverInstall('failed')).toBe(false)
    expect(canOfferNvidiaDriverInstall('permissionDenied')).toBe(false)
    expect(canOfferNvidiaDriverInstall('missing')).toBe(true)
  })

  it('persists valid ignored server ids and restores their display status', () => {
    expect([...parseIgnoredNvidiaWarningIds('["server-a", 4, ""]')]).toEqual(['server-a'])
    expect(parseIgnoredNvidiaWarningIds('not-json').size).toBe(0)
    const snapshot = { nvidiaSmi: 'degraded', status: 'warning' } as Parameters<typeof displayedNvidiaServerStatus>[0]
    expect(displayedNvidiaServerStatus(snapshot, true)).toBe('online')
    expect(displayedNvidiaServerStatus(snapshot, false)).toBe('warning')
  })
})
