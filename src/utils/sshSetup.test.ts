import { describe, expect, it } from 'vitest'
import { isRackTopManagedIdentity, RACKTOP_MANAGED_IDENTITY_PATH, sshSetupTargetValidationMessage, unixSshSetupScript, windowsSshSetupScript } from './sshSetup'

describe('SSH setup scripts', () => {
  it('renders a directly runnable macOS/Linux script with the current target', () => {
    const script = unixSshSetupScript({ username: 'tongzh', host: '10.0.0.1', port: 2222 })
    expect(script).toContain('cat "$KEY_PATH.pub" | ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -o IdentitiesOnly=yes -p 2222 \'tongzh@10.0.0.1\'')
    expect(script).not.toContain('\nssh-copy-id ')
    expect(script).toContain('KEY_PATH="$HOME/.ssh/racktop_ed25519"')
    expect(script).toContain('mkdir -p "$HOME/.ssh"')
    expect(script).toContain('set -eu')
    expect(script).toContain('racktop-managed:$KEY_ID')
    expect(script).toContain("ssh -o BatchMode=yes -o IdentitiesOnly=yes -i \"$KEY_PATH\" -p 2222 'tongzh@10.0.0.1'")
    expect(script).toContain('__RACKTOP_SSH_READY__')
    expect(script).toContain('# 本机：')
    expect(script).toContain('# 远程：')
    expect(script).toContain('ProxyCommand / ProxyJump')
  })

  it('renders a PowerShell script that performs the remote append through ssh', () => {
    const script = windowsSshSetupScript({ username: 'researcher', host: 'gpu.example.com', port: 22 })
    expect(script).toContain('$env:USERPROFILE')
    expect(script).toContain('$ErrorActionPreference = "Stop"')
    expect(script).toContain('$sshDirectory = Join-Path $env:USERPROFILE ".ssh"')
    expect(script).toContain('$keyPath = Join-Path $sshDirectory "racktop_ed25519"')
    expect(script).toContain('racktop-managed:$keyId')
    expect(script).toContain("ssh-keygen -q -t ed25519 -N '\"\"'")
    expect(script).toContain('New-Item -ItemType Directory -Force -Path $sshDirectory')
    expect(script).toContain('if ($LASTEXITCODE -ne 0) { throw')
    expect(script).toContain('if (-not (Test-Path $publicKeyPath)) { throw')
    expect(script).toContain('Get-Content $publicKeyPath | ssh')
    expect(script).toContain('RackTop 公钥写入服务器失败')
    expect(script).toContain("ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -p 22 'researcher@gpu.example.com' 'umask 077;")
    expect(script).toContain('ssh -o BatchMode=yes -o IdentitiesOnly=yes -i $keyPath')
    expect(script).toContain('__RACKTOP_SSH_READY__')
  })

  it('identifies only the dedicated RackTop identity path', () => {
    expect(RACKTOP_MANAGED_IDENTITY_PATH).toBe('~/.ssh/racktop_ed25519')
    expect(isRackTopManagedIdentity('~/.ssh/racktop_ed25519')).toBe(true)
    expect(isRackTopManagedIdentity('C:\\Users\\alice\\.ssh\\racktop_ed25519')).toBe(true)
    expect(isRackTopManagedIdentity('~/.ssh/id_ed25519')).toBe(false)
  })
})

describe('sshSetupTargetValidationMessage', () => {
  it('identifies every missing connection field before copying', () => {
    expect(sshSetupTargetValidationMessage({ username: '', host: '', port: 22 })).toContain('用户名和主机地址')
    expect(sshSetupTargetValidationMessage({ username: '', host: '10.0.0.10', port: 22 })).toContain('用户名')
    expect(sshSetupTargetValidationMessage({ username: 'researcher', host: '', port: 22 })).toContain('主机地址')
  })

  it('allows copying only after username and host are both filled', () => {
    expect(sshSetupTargetValidationMessage({ username: ' researcher ', host: ' 10.0.0.10 ', port: 22 })).toBeNull()
  })
})
