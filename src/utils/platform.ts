export type AppPlatform = 'macos' | 'windows' | 'web'

export function detectAppPlatform(isDesktop: boolean, userAgent: string): AppPlatform {
  if (!isDesktop) return 'web'
  if (/Windows/i.test(userAgent)) return 'windows'
  return 'macos'
}

