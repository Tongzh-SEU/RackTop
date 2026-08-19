export interface CudaCommandAnalysis {
  command: string
  modified: boolean
  requiresConfirmation: boolean
  message?: string
}

const CUDA_ASSIGNMENT = /(^|[;|&]\s*|\s+)(export\s+)?CUDA_VISIBLE_DEVICES\s*=\s*([^\s;|&]+)/g
const NUMERIC_LIST = /^\d+(?:,\d+)*$/
const SIMPLE_VARIABLE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/

function resolvedVariable(command: string, name: string): string | null {
  const matcher = new RegExp(`(?:^|[;\\s])(?:export\\s+)?${name}\\s*=\\s*(\\d+(?:,\\d+)*)(?=$|[;\\s])`, 'g')
  let value: string | null = null
  for (const match of command.matchAll(matcher)) value = match[1]
  return value
}

export function analyzeCudaCommand(command: string, gpuIndex: number): CudaCommandAnalysis {
  const target = String(gpuIndex)
  let modified = false
  let requiresConfirmation = false
  let found = false
  const rewritten = command.replace(CUDA_ASSIGNMENT, (assignment, prefix: string, exported: string | undefined, rawValue: string) => {
    found = true
    const variable = rawValue.match(SIMPLE_VARIABLE)
    const resolved = variable ? resolvedVariable(command.slice(0, command.indexOf(assignment)), variable[1]) : null
    const value = resolved ?? rawValue
    if (NUMERIC_LIST.test(value)) {
      if (value.split(',').length !== 1 || value !== target) {
        modified = true
        return `${prefix}${exported ?? ''}CUDA_VISIBLE_DEVICES=${target}`
      }
      return assignment
    }
    requiresConfirmation = true
    return assignment
  })

  if (requiresConfirmation) {
    return { command, modified: false, requiresConfirmation: true, message: `无法静态确认 CUDA_VISIBLE_DEVICES 是否指向 GPU ${gpuIndex}` }
  }
  if (modified) return { command: rewritten, modified: true, requiresConfirmation: false, message: `已将 CUDA_VISIBLE_DEVICES 固定为 GPU ${gpuIndex}` }
  return { command: rewritten, modified: false, requiresConfirmation: false, message: found ? undefined : undefined }
}
