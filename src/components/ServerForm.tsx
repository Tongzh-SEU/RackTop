import { useState, type FormEvent } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, ShieldCheck, X } from 'lucide-react'
import type { ServerDraft } from '../types/models'
import { unixSshSetupScript, windowsSshSetupScript } from '../utils/sshSetup'

interface ServerFormProps {
  initial?: Partial<ServerDraft>
  defaultSamplingInterval?: number
  defaultHistoryRetentionDays?: number
  onClose: () => void
  onSave: (draft: ServerDraft) => Promise<void>
}

export function ServerForm({ initial, defaultSamplingInterval = 2, defaultHistoryRetentionDays = 30, onClose, onSave }: ServerFormProps) {
  const [draft, setDraft] = useState<ServerDraft>({
    id: initial?.id,
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    username: initial?.username ?? '',
    sshAlias: initial?.sshAlias ?? '',
    identityFile: initial?.identityFile ?? '',
    proxyJump: initial?.proxyJump ?? '',
    tags: initial?.tags ?? [],
    samplingIntervalSeconds: initial?.samplingIntervalSeconds ?? defaultSamplingInterval,
    historyRetentionDays: initial?.historyRetentionDays ?? defaultHistoryRetentionDays,
    authMethod: initial?.authMethod ?? 'sshAgent',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [passwordAcknowledged, setPasswordAcknowledged] = useState(false)
  const [setupCopied, setSetupCopied] = useState(false)

  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const setupPlatform = /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix'
  const setupTarget = { username: draft.username, host: draft.host, port: draft.port }
  const setupScript = setupPlatform === 'unix' ? unixSshSetupScript(setupTarget) : windowsSshSetupScript(setupTarget)

  async function copySetupScript() {
    try {
      await navigator.clipboard.writeText(setupScript)
      setSetupCopied(true)
      window.setTimeout(() => setSetupCopied(false), 1600)
    } catch {
      setError('无法访问剪贴板，请手动选择脚本复制。')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (draft.authMethod === 'password' && !passwordAcknowledged) return
    setSaving(true)
    setError(null)
    try {
      await onSave({ ...draft, name: draft.name || draft.sshAlias || draft.host })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="server-form-title">
        <header className="sheet__header">
          <div>
            <p className="eyebrow">SSH 服务器</p>
            <h2 id="server-form-title">{initial?.id ? '编辑服务器' : '添加服务器'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <form onSubmit={submit} className="form-stack">
          <div className="form-grid form-grid--2">
            <label>显示名称<input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="训练服务器 A" /></label>
            <label>SSH Config 别名<input value={draft.sshAlias ?? ''} onChange={(event) => set('sshAlias', event.target.value)} placeholder="可选，例如 gpu-a" /></label>
          </div>
          <div className="form-grid form-grid--host">
            <label>主机地址<input required value={draft.host} onChange={(event) => set('host', event.target.value)} placeholder="10.0.0.10" /></label>
            <label>端口<input required type="number" min="1" max="65535" value={draft.port} onChange={(event) => set('port', Number(event.target.value))} /></label>
            <label>用户名<input required value={draft.username} onChange={(event) => set('username', event.target.value)} placeholder="researcher" /></label>
          </div>
          <fieldset>
            <legend>认证方式</legend>
            <div className="segmented segmented--auth">
              {([
                ['sshAgent', 'SSH Agent'],
                ['privateKey', '私钥'],
                ['sshConfig', 'SSH Config'],
                ['password', '密码'],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" className={draft.authMethod === value ? 'is-selected' : ''} onClick={() => set('authMethod', value)}>{label}</button>
              ))}
            </div>
          </fieldset>
          {draft.authMethod === 'privateKey' && (
            <label>私钥路径<input value={draft.identityFile ?? ''} onChange={(event) => set('identityFile', event.target.value)} placeholder="~/.ssh/id_ed25519" /></label>
          )}
          {draft.authMethod === 'password' && (
            <div className="security-warning">
              <AlertTriangle size={20} />
              <div>
                <strong>不建议长期使用密码登录</strong>
                <p>优先使用 Ed25519 私钥或 SSH Agent。RackTop 不会把密码写入配置或 SQLite；选择保存时仅写入系统安全凭据存储。</p>
                <label className="checkbox-row">
                  <input type="checkbox" checked={passwordAcknowledged} onChange={(event) => setPasswordAcknowledged(event.target.checked)} />
                  我理解风险并继续使用密码
                </label>
                <button type="button" className="button button--secondary button--small" onClick={() => set('authMethod', 'privateKey')}><KeyRound size={14} />使用 SSH 私钥（推荐）</button>
              </div>
            </div>
          )}
          {draft.authMethod === 'password' && passwordAcknowledged && (
            <div className="form-grid form-grid--2">
              <label>密码<input type="password" value={draft.password ?? ''} onChange={(event) => set('password', event.target.value)} autoComplete="new-password" /></label>
              <label className="checkbox-card"><input type="checkbox" checked={draft.savePassword ?? false} onChange={(event) => set('savePassword', event.target.checked)} /><ShieldCheck size={18} /><span>保存到系统钥匙串</span></label>
            </div>
          )}
          <div className="form-grid form-grid--2">
            <label>跳板机 ProxyJump<input value={draft.proxyJump ?? ''} onChange={(event) => set('proxyJump', event.target.value)} placeholder="可选" /></label>
            <label>标签<input value={draft.tags.join(', ')} onChange={(event) => set('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} placeholder="lab, h100" /></label>
          </div>
          <div className="form-grid form-grid--2">
            <label>此服务器采样间隔<select value={draft.samplingIntervalSeconds} onChange={(event) => set('samplingIntervalSeconds', Number(event.target.value))}><option value="2">2 秒</option><option value="5">5 秒</option><option value="10">10 秒</option><option value="15">15 秒</option><option value="30">30 秒</option></select><small>前台使用；后台会自动采用更低频率。</small></label>
            <label>此服务器历史保存<select value={draft.historyRetentionDays} onChange={(event) => set('historyRetentionDays', Number(event.target.value))}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><small>独立覆盖全局默认保存时间。</small></label>
          </div>
          <details className="key-guide">
            <summary><KeyRound size={17} />SSH 密钥快速配置</summary>
            <div className="key-guide__toolbar">
              <span className="key-guide__platform-label">已检测：{setupPlatform === 'windows' ? '本机 Windows PowerShell → 远程 Linux' : '本机 macOS Terminal → 远程 Linux'}</span>
              <button type="button" className="button button--secondary button--small" onClick={() => void copySetupScript()}>{setupCopied ? <Check size={13} /> : <Copy size={13} />}{setupCopied ? '已复制' : '复制整段'}</button>
            </div>
            <pre><code>{setupScript}</code></pre>
          </details>
          {error && <p className="form-error" role="alert">{error}</p>}
          <footer className="sheet__footer">
            <button type="button" className="button button--secondary" onClick={onClose}>取消</button>
            <button type="submit" className="button button--primary" disabled={saving || (draft.authMethod === 'password' && !passwordAcknowledged)}>
              <Check size={17} />{saving ? '保存中…' : '保存并连接'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}
