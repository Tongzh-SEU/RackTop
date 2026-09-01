import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

export type DesktopAppUpdate = Update
export type DesktopDownloadEvent = DownloadEvent

export function checkDesktopAppUpdate() {
  return check({ timeout: 30_000 })
}

export function relaunchUpdatedApp() {
  return relaunch()
}
