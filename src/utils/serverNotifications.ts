import type { ServerNotificationCategory, ServerNotificationSettings } from '../types/models'

export function defaultServerNotificationSettings(serverId: string): ServerNotificationSettings {
  return { serverId, mode: 'all', task: true, zombie: true, memory: true, system: true }
}

export function normalizeServerNotificationSettings(settings: ServerNotificationSettings): ServerNotificationSettings {
  const enabledCount = [settings.task, settings.zombie, settings.memory, settings.system].filter(Boolean).length
  if (settings.mode === 'off') return { ...settings, task: false, zombie: false, memory: false, system: false }
  if (settings.mode === 'all' || enabledCount === 4) return { ...settings, mode: 'all', task: true, zombie: true, memory: true, system: true }
  if (enabledCount === 0) return { ...settings, mode: 'partial', task: true }
  return settings
}

export function allowsServerNotification(settings: ServerNotificationSettings | undefined, category: ServerNotificationCategory) {
  if (!settings || settings.mode === 'all') return true
  if (settings.mode === 'off') return false
  return settings[category]
}
