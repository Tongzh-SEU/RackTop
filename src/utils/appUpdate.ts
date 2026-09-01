export type AppUpdatePhase = 'checking' | 'downloading' | 'installing' | 'error'

export interface AppUpdateState {
  phase: AppUpdatePhase
  version: string
  downloadedBytes: number
  totalBytes: number | null
  error?: string
}

export type AppUpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished'; data?: Record<string, never> }

export function initialAppUpdateState(version: string): AppUpdateState {
  return { phase: 'downloading', version, downloadedBytes: 0, totalBytes: null }
}

export function applyAppUpdateDownloadEvent(state: AppUpdateState, event: AppUpdateDownloadEvent): AppUpdateState {
  if (event.event === 'Started') {
    return { ...state, phase: 'downloading', downloadedBytes: 0, totalBytes: event.data.contentLength || null, error: undefined }
  }
  if (event.event === 'Progress') {
    return { ...state, phase: 'downloading', downloadedBytes: state.downloadedBytes + event.data.chunkLength }
  }
  return { ...state, phase: 'installing', downloadedBytes: state.totalBytes ?? state.downloadedBytes }
}

export function appUpdatePercent(state: AppUpdateState) {
  if (!state.totalBytes || state.totalBytes <= 0) return null
  return Math.min(100, Math.max(0, state.downloadedBytes / state.totalBytes * 100))
}

export function formatUpdateBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}
