export function serverDisplayName(name: string) {
  const normalized = name.trim()
  if (!normalized) return '未命名服务器'
  return normalized.includes('服务器') ? normalized : `${normalized} 服务器`
}

export function gpuContextName(serverName: string, gpuIndex: number, gpuName: string) {
  return `${serverDisplayName(serverName)} · GPU ${gpuIndex} · ${gpuName.replace(/^NVIDIA\s+/i, '')}`
}
