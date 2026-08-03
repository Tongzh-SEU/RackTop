import { describe, expect, it } from 'vitest'
import { unixSshSetupScript, windowsSshSetupScript } from './sshSetup'

describe('SSH setup scripts', () => {
  it('renders a directly runnable macOS/Linux script with the current target', () => {
    const script = unixSshSetupScript({ username: 'tongzh', host: '10.0.0.1', port: 2222 })
    expect(script).toContain('ssh-copy-id -i "$KEY_PATH.pub" -p 2222 \'tongzh@10.0.0.1\'')
    expect(script).toContain('ssh -p 2222 \'tongzh@10.0.0.1\'')
    expect(script).toContain('# 本机：')
    expect(script).toContain('# 远程：')
  })

  it('renders a PowerShell script that performs the remote append through ssh', () => {
    const script = windowsSshSetupScript({ username: 'researcher', host: 'gpu.example.com', port: 22 })
    expect(script).toContain('$env:USERPROFILE')
    expect(script).toContain("ssh -p 22 'researcher@gpu.example.com' 'umask 077;")
    expect(script).toContain('ssh-add $keyPath')
  })
})
