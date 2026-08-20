type SshSetupTarget = {
  username: string
  host: string
  port: number
}

export const RACKTOP_MANAGED_IDENTITY_PATH = '~/.ssh/racktop_ed25519'

export function isRackTopManagedIdentity(identityFile?: string | null) {
  return identityFile?.trim().replaceAll('\\', '/').endsWith('/.ssh/racktop_ed25519') ?? false
}

export function sshSetupTargetValidationMessage({ username, host }: SshSetupTarget) {
  const missingUsername = !username.trim()
  const missingHost = !host.trim()
  if (missingUsername && missingHost) return '请先填写用户名和主机地址，再复制快速配置命令。'
  if (missingUsername) return '请先填写用户名，再复制快速配置命令。'
  if (missingHost) return '请先填写主机地址，再复制快速配置命令。'
  return null
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

export function unixSshSetupScript({ username, host, port }: SshSetupTarget) {
  const target = shellQuote(`${username.trim() || 'user'}@${host.trim() || 'server'}`)
  const sshPort = Number.isInteger(port) && port > 0 ? port : 22
  return `#!/bin/sh
set -eu

# 在本机终端执行（macOS / Linux）。整段复制粘贴即可。
# ssh 会自动连接远程 Linux 服务器，无需先登录。
KEY_PATH="$HOME/.ssh/racktop_ed25519"

# 本机：生成 RackTop 专用密钥，已有密钥不会覆盖。
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY_PATH" ]; then
  KEY_ID="$(uuidgen 2>/dev/null || printf '%s' "$(hostname)-$$-$(date +%s)")"
  ssh-keygen -q -t ed25519 -N "" -C "racktop-managed:$KEY_ID" -f "$KEY_PATH"
fi

# 远程：通过一次密码 SSH 连接将公钥追加到 authorized_keys。
# 不使用 ssh-copy-id，避免它先探测密钥、再写入而产生两次连接。
if ! cat "$KEY_PATH.pub" | ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -o IdentitiesOnly=yes -p ${sshPort} ${target} 'umask 077; mkdir -p ~/.ssh; chmod 700 ~/.ssh; cat >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys'; then
  printf '%s\\n' 'RackTop 公钥写入服务器失败。若提示 Connection closed by 127.0.0.1:端口，请检查本机 SSH 代理是否正在运行，或检查 ~/.ssh/config 中的 ProxyCommand / ProxyJump。' >&2
  exit 1
fi

# 本机：只使用 RackTop 专用私钥测试免密登录，成功后自动退出。
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY_PATH" -p ${sshPort} ${target} 'printf "__RACKTOP_SSH_READY__\\n"'`
}

export function windowsSshSetupScript({ username, host, port }: SshSetupTarget) {
  const target = powershellQuote(`${username.trim() || 'user'}@${host.trim() || 'server'}`)
  const sshPort = Number.isInteger(port) && port > 0 ? port : 22
  return `$ErrorActionPreference = "Stop"

# 在本机 PowerShell 执行。整段复制粘贴即可。
# ssh 后面引号内的命令会自动在远程 Linux 服务器执行。
$sshDirectory = Join-Path $env:USERPROFILE ".ssh"
$keyPath = Join-Path $sshDirectory "racktop_ed25519"
$publicKeyPath = "$keyPath.pub"

# 本机：生成 RackTop 专用密钥，已有密钥不会覆盖。
if (-not (Test-Path $keyPath)) {
  New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null
  $keyId = [guid]::NewGuid().ToString()
  ssh-keygen -q -t ed25519 -N '""' -C "racktop-managed:$keyId" -f $keyPath
  if ($LASTEXITCODE -ne 0) { throw "RackTop 专用密钥生成失败（ssh-keygen 退出码 $LASTEXITCODE）。" }
}
if (-not (Test-Path $publicKeyPath)) { throw "未找到 RackTop 公钥：$publicKeyPath" }

# 远程：创建 .ssh 并将本机公钥追加到 authorized_keys。
Get-Content $publicKeyPath | ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -p ${sshPort} ${target} 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'
if ($LASTEXITCODE -ne 0) { throw "RackTop 公钥写入服务器失败（ssh 退出码 $LASTEXITCODE）。" }

# 本机：只使用 RackTop 专用私钥测试免密登录，成功后自动退出。
ssh -o BatchMode=yes -o IdentitiesOnly=yes -i $keyPath -p ${sshPort} ${target} 'printf "__RACKTOP_SSH_READY__\\n"'
if ($LASTEXITCODE -ne 0) { throw "RackTop 专用密钥验证失败（ssh 退出码 $LASTEXITCODE）。" }`
}
