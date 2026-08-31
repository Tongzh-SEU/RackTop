import { describe, expect, it } from 'vitest'
import { allowsServerNotification, defaultServerNotificationSettings, normalizeServerNotificationSettings } from './serverNotifications'

describe('server notification settings', () => {
  it('defaults missing server settings to all notifications', () => {
    expect(allowsServerNotification(undefined, 'system')).toBe(true)
    expect(defaultServerNotificationSettings('server')).toMatchObject({ mode: 'all', task: true, zombie: true, memory: true, system: true })
  })

  it('normalizes four selected partial categories to all and preserves a real partial selection', () => {
    const all = { ...defaultServerNotificationSettings('server'), mode: 'partial' as const }
    expect(normalizeServerNotificationSettings(all).mode).toBe('all')
    const partial = normalizeServerNotificationSettings({ ...all, zombie: false })
    expect(partial.mode).toBe('partial')
    expect(allowsServerNotification(partial, 'task')).toBe(true)
    expect(allowsServerNotification(partial, 'zombie')).toBe(false)
  })

  it('keeps at least one category in partial mode and disables all regular categories in off mode', () => {
    const empty = normalizeServerNotificationSettings({ serverId: 'server', mode: 'partial', task: false, zombie: false, memory: false, system: false })
    expect(empty.task).toBe(true)
    const off = normalizeServerNotificationSettings({ ...defaultServerNotificationSettings('server'), mode: 'off' })
    expect(['task', 'zombie', 'memory', 'system'].every((category) => !allowsServerNotification(off, category as 'task'))).toBe(true)
  })
})
