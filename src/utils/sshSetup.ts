type SshSetupTarget = {
  username: string
  host: string
  port: number
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
  return `# 在本机终端执行（macOS / Linux）。整段复制粘贴即可。
# ssh-copy-id 和 ssh 会自动连接远程 Linux 服务器，无需先登录。
KEY_PATH="$HOME/.ssh/id_ed25519"

# 本机：没有密钥时才生成，已有密钥不会覆盖。
if [ ! -f "$KEY_PATH" ]; then
  ssh-keygen -t ed25519 -C "RackTop" -f "$KEY_PATH"
fi

# 远程：将公钥追加到服务器的 authorized_keys。
ssh-copy-id -i "$KEY_PATH.pub" -p ${sshPort} ${target}

# 本机：将私钥交给 SSH Agent，并测试免密登录。
ssh-add "$KEY_PATH"
ssh -p ${sshPort} ${target}`
}

export function windowsSshSetupScript({ username, host, port }: SshSetupTarget) {
  const target = powershellQuote(`${username.trim() || 'user'}@${host.trim() || 'server'}`)
  const sshPort = Number.isInteger(port) && port > 0 ? port : 22
  return `# 在本机 PowerShell 执行。整段复制粘贴即可。
# ssh 后面引号内的命令会自动在远程 Linux 服务器执行。
$keyPath = Join-Path $env:USERPROFILE ".ssh\\id_ed25519"

# 本机：没有密钥时才生成，已有密钥不会覆盖。
if (-not (Test-Path $keyPath)) {
  ssh-keygen -t ed25519 -C "RackTop" -f $keyPath
}

# 远程：创建 .ssh 并将本机公钥追加到 authorized_keys。
Get-Content "$keyPath.pub" | ssh -p ${sshPort} ${target} 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys'

# 本机：将私钥交给 SSH Agent，并测试免密登录。
ssh-add $keyPath
ssh -p ${sshPort} ${target}`
}
