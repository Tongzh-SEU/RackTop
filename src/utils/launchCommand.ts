export type NormalizedLaunchCommand = {
  command: string
  detectedWorkingDirectory: string | null
  detectedCudaVisibleDevices: number[] | null
  detectedProjectLogPath: string | null
  replacedCudaVisibleDevices: boolean
  removedNoHup: boolean
  removedRackTopConflicts: boolean
}

export type LaunchParameter = {
  name: string
  value: string
  hasValue: boolean
  start: number
  end: number
}

function shellValue(value: string) {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  return trimmed
}

function detectProjectLogPath(command: string) {
  const value = '("[^"]*"|\'[^\']*\'|[^\\s\\n]+)'
  const patterns = [
    new RegExp(`(?:^|\\s)(?:1?>|>>)\\s*${value}`, 'm'),
    new RegExp(`(?:^|\\|)\\s*tee(?:\\s+-a)?\\s+${value}`, 'm'),
    new RegExp(`--(?:log-file|log-path|logfile|output-log)(?:=|\\s+)${value}`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = command.match(pattern)
    if (match?.[1]) return shellValue(match[1])
  }
  return null
}

/**
 * Keeps the user's workload commands, while removing shell setup RackTop owns.
 * This is intentionally conservative: arbitrary shell syntax remains untouched.
 */
export function normalizeLaunchCommand(input: string): NormalizedLaunchCommand {
  let command = input.trim()
  let detectedWorkingDirectory: string | null = null
  let detectedCudaVisibleDevices: number[] | null = null
  let detectedProjectLogPath: string | null = null
  let removedNoHup = false
  let replacedCudaVisibleDevices = false
  let removedRackTopConflicts = false

  command = command.replace(/^\s*cd\s+(?:--\s+)?((?:"[^"]*")|(?:'[^']*')|[^\s;&]+)\s*(?:&&\s*)?$/gm, (_match, directory: string) => {
    detectedWorkingDirectory ??= shellValue(directory)
    removedRackTopConflicts = true
    return ''
  })
  command = command.replace(/(^|\s)nohup\s+/g, (_match, prefix: string) => {
    removedNoHup = true
    removedRackTopConflicts = true
    return prefix
  })
  command = command.replace(/(^|[\s\\])CUDA_VISIBLE_DEVICES\s*=\s*("[^"]*"|'[^']*'|[^\s\\;]+)/g, (_match, prefix: string, devices: string) => {
    const parsed = shellValue(devices).split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 0)
    if (parsed.length > 0) detectedCudaVisibleDevices ??= parsed
    replacedCudaVisibleDevices = true
    removedRackTopConflicts = true
    return prefix
  })
  // `nohup env CUDA_VISIBLE_DEVICES=…` is a single wrapper. Once CUDA is
  // owned by RackTop, remove its now-orphaned `env` while retaining user env vars.
  if (replacedCudaVisibleDevices) {
    command = command.replace(/(^|\n)\s*env\s*(?:\\\s*)?(?:\n\s*)?(?=[A-Z_][A-Z0-9_]*=)/g, '$1')
  }
  command = command.replace(/^\s*echo\s+.*(?:\$!|launcher\.pid).*$(?:\n|$)/gim, () => {
    removedRackTopConflicts = true
    return ''
  })
  command = command.replace(/(?:\s+>\s*|(?:^|\n)\s*)("[^"]*"|'[^']*'|[^\s\n]+)\s+2>&1\s*&?(?=\s*(?:\n|$))/g, (_match, logPath: string) => {
    detectedProjectLogPath ??= shellValue(logPath)
    removedRackTopConflicts = true
    return ''
  })
  detectedProjectLogPath ??= detectProjectLogPath(command)
  command = command.replace(/\\\s*(?=\n\s*(?:\n|$))/g, '')
  command = command.replace(/^\s*\n|\n\s*$/g, '').replace(/\n{3,}/g, '\n\n').trim()

  return { command, detectedWorkingDirectory, detectedCudaVisibleDevices, detectedProjectLogPath, replacedCudaVisibleDevices, removedNoHup, removedRackTopConflicts }
}

/** Resolves simple leading shell variables used in an extracted project log path. */
export function resolveProjectLogPath(logPath: string, command: string) {
  const variables = new Map<string, string>()
  for (const line of command.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.+?)\s*$/)
    if (match) variables.set(match[1], shellValue(match[2]))
  }
  return logPath.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (source, braced: string | undefined, plain: string | undefined) => variables.get(braced ?? plain ?? '') ?? source)
}

export function launchCommandPreview(workingDirectory: string, command: string, gpuIndices: number[]) {
  const gpuCsv = gpuIndices.join(',')
  return `cd -- ${workingDirectory}\nCUDA_VISIBLE_DEVICES=${gpuCsv} \\\n${command}`
}

/** Replaces RackTop-owned context in a copied command without discarding its structure. */
export function replaceLaunchContext(command: string, workingDirectory: string, gpuIndices: number[]) {
  const gpuCsv = gpuIndices.join(',')
  let preview = command.trim()
  let replacedDirectory = false
  preview = preview.replace(/^\s*cd\s+(?:--\s+)?(?:(?:"[^"]*")|(?:'[^']*')|[^\s;&]+)(?=\s*(?:&&)?\s*(?:\n|$))/m, () => {
    replacedDirectory = true
    return `cd ${workingDirectory}`
  })
  if (!replacedDirectory) preview = `cd ${workingDirectory}\n${preview}`
  return preview.replace(/CUDA_VISIBLE_DEVICES\s*=\s*(?:"[^"]*"|'[^']*'|[^\s\\;]+)/, `CUDA_VISIBLE_DEVICES=${gpuCsv}`)
}

/** Extracts conventional long options without trying to interpret the whole shell script. */
export function parseLaunchParameters(command: string): LaunchParameter[] {
  const tokens = [...command.matchAll(/(?:[^\s"'\\]|\\.)+|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'/g)]
    .map((match) => ({ value: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length }))
  const parameters: LaunchParameter[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!/^--[A-Za-z][\w-]*$/.test(token.value)) continue
    let nextIndex = index + 1
    while (tokens[nextIndex]?.value === '\\') nextIndex += 1
    const valueToken = tokens[nextIndex]
    const hasValue = Boolean(valueToken && !valueToken.value.startsWith('--'))
    parameters.push({
      name: token.value,
      value: hasValue ? valueToken.value : '',
      hasValue,
      start: token.start,
      end: hasValue ? valueToken.end : token.end,
    })
  }

  return parameters
}

/** Returns flags belonging to the final Python workload, excluding launcher flags. */
export function parseTaskParameters(command: string) {
  const invocations = [...command.matchAll(/(?:^|\s)(?:[\w./-]*\/)?python(?:\d(?:\.\d+)?)?\s+[^\s\\]+/g)]
  const workload = invocations.at(-1)
  if (!workload || workload.index == null) return []
  const workloadStart = workload.index + workload[0].length
  return parseLaunchParameters(command).filter((parameter) => parameter.start >= workloadStart)
}

export function updateLaunchParameter(command: string, parameter: LaunchParameter, value: string, enabled = true) {
  if (!enabled) return `${command.slice(0, parameter.start)}${command.slice(parameter.end)}`.replace(/[ \t]{2,}/g, ' ')
  const replacement = value.trim() ? `${parameter.name} ${value}` : parameter.name
  return `${command.slice(0, parameter.start)}${replacement}${command.slice(parameter.end)}`
}
