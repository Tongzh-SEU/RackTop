export interface ReleaseInfo {
  version: string
  url: string
  publishedAt?: string
}

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_CHECK_STORAGE_KEY = 'racktop.updateCheck.v1'
export const IGNORED_UPDATE_VERSION_KEY = 'racktop.ignoredUpdateVersion.v1'

function versionParts(version: string) {
  return version.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
}

export function isNewerVersion(candidate: string, current: string) {
  const left = versionParts(candidate)
  const right = versionParts(current)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

export function shouldCheckForUpdates(lastCheckedAt: number | undefined, now = Date.now()) {
  return !lastCheckedAt || now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
}

export function shouldShowUpdateBadge(releaseVersion: string | undefined, ignoredVersion: string | undefined) {
  return Boolean(releaseVersion && releaseVersion !== ignoredVersion)
}

export function loadCachedUpdate(): { lastCheckedAt?: number; release?: ReleaseInfo } {
  try { return JSON.parse(localStorage.getItem(UPDATE_CHECK_STORAGE_KEY) ?? '{}') }
  catch { return {} }
}

export function saveCachedUpdate(value: { lastCheckedAt: number; release?: ReleaseInfo }) {
  localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, JSON.stringify(value))
}

export function loadIgnoredUpdateVersion() {
  return localStorage.getItem(IGNORED_UPDATE_VERSION_KEY) ?? undefined
}

export function saveIgnoredUpdateVersion(version: string) {
  localStorage.setItem(IGNORED_UPDATE_VERSION_KEY, version)
}
