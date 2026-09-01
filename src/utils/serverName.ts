export function serverDisplayName(name: string) {
  const normalized = name.trim()
  if (!normalized) return '未命名服务器'
  return normalized.includes('服务器') ? normalized : `${normalized} 服务器`
}

export function gpuContextName(serverName: string, gpuIndex: number, gpuName: string, accelerator = 'GPU') {
  return `${serverDisplayName(serverName)} · ${accelerator} ${gpuIndex} · ${gpuName.replace(/^NVIDIA\s+/i, '')}`
}
