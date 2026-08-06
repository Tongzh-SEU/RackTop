import { describe, expect, it } from 'vitest'
import { gpuContextName, serverDisplayName } from './serverName'

describe('serverDisplayName', () => {
  it('adds a server suffix once', () => {
    expect(serverDisplayName('3 * A100')).toBe('3 * A100 服务器')
    expect(serverDisplayName('训练服务器 A')).toBe('训练服务器 A')
  })

  it('formats a GPU notification context', () => {
    expect(gpuContextName('3 * A100', 0, 'NVIDIA A100-PCIE-40GB')).toBe('3 * A100 服务器 · GPU 0 · A100-PCIE-40GB')
  })
})
