import type { LaunchProfile, ManagedRun, Snapshot } from '../types/models'

const PROFILE_KEY = 'racktop.launchProfiles.v1'
const RUN_KEY = 'racktop.managedRuns.v1'
const MAX_RECENT_RUNS = 60

function parseArray<T>(key: string): T[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function loadLaunchProfiles() {
  return parseArray<LaunchProfile>(PROFILE_KEY).filter((profile) => profile.id && profile.name && profile.command)
}

export function saveLaunchProfiles(profiles: LaunchProfile[]) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles))
}

export function loadManagedRuns() {
  return parseArray<ManagedRun>(RUN_KEY).filter((run) => run.id && run.serverId && run.command && Number.isInteger(run.pid))
}

export function saveManagedRuns(runs: ManagedRun[]) {
  const active = runs.filter((run) => ['starting', 'running', 'unknown'].includes(run.status))
  const recent = runs.filter((run) => !['starting', 'running', 'unknown'].includes(run.status)).sort((left, right) => right.startedAt - left.startedAt).slice(0, MAX_RECENT_RUNS)
  localStorage.setItem(RUN_KEY, JSON.stringify([...active, ...recent]))
}

function normalizedCommand(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

export function runMatchesProcess(run: ManagedRun, process: { pid: number; parentPid: number; command: string }) {
  if (process.pid === run.pid || process.parentPid === run.pid) return true
  const command = normalizedCommand(run.command)
  const observed = normalizedCommand(process.command)
  if (!command || !observed) return false
  const executable = command.split(' ')[0].split('/').pop() ?? ''
  const distinctiveArgument = command.split(' ').find((part) => part.length >= 8 && !part.startsWith('-'))
  return Boolean(executable && observed.includes(executable) && (!distinctiveArgument || observed.includes(distinctiveArgument)))
}

function processCanBelongToRun(run: ManagedRun, process: { isCurrentUser?: boolean; gpuUuid?: string }) {
  if (process.isCurrentUser === false) return false
  if (process.gpuUuid && !run.gpuUuids.includes(process.gpuUuid)) return false
  return true
}

export function runProcesses(run: ManagedRun, snapshot?: Snapshot) {
  if (!snapshot || snapshot.serverId !== run.serverId) return []
  return [...snapshot.processes, ...snapshot.cpuProcesses].filter((process) => processCanBelongToRun(run, process) && runMatchesProcess(run, process))
}

export function runIsObserved(run: ManagedRun, snapshot?: Snapshot) {
  return runProcesses(run, snapshot).length > 0
}

export function processBelongsToManagedRun(serverId: string, process: { pid: number; parentPid: number; command: string; isCurrentUser?: boolean; gpuUuid?: string }, runs: ManagedRun[]) {
  return runs.some((run) => run.serverId === serverId && ['starting', 'running', 'unknown'].includes(run.status) && processCanBelongToRun(run, process) && runMatchesProcess(run, process))
}

export function projectPathOnServer(project: { sourceServerId: string; sourcePath: string; targets: Array<{ serverId: string; path: string }> }, serverId: string) {
  if (project.sourceServerId === serverId) return project.sourcePath
  return project.targets.find((target) => target.serverId === serverId)?.path ?? ''
}

export function projectWorkingDirectory(project: { sourceServerId: string; sourcePath: string; sourceIsDirectory?: boolean; targets: Array<{ serverId: string; path: string }> }, serverId: string) {
  const path = projectPathOnServer(project, serverId).replace(/\/+$/, '')
  if (!path || project.sourceIsDirectory !== false) return path
  const separator = path.lastIndexOf('/')
  if (separator < 0) return '.'
  if (separator === 0) return '/'
  return path.slice(0, separator)
}
