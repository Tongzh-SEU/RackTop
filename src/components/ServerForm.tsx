import { useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowRight, Check, ChevronRight, Copy, Database, KeyRound, ShieldCheck, Terminal, X } from 'lucide-react'
import type { ServerDraft } from '../types/models'
import { sshSetupTargetValidationMessage, unixSshSetupScript, windowsSshSetupScript } from '../utils/sshSetup'
import { Modal } from './Modal'

interface ServerFormProps {
  initial?: Partial<ServerDraft>
  defaultRemoteHistoryEnabled?: boolean
  showGuide?: boolean
  onGuideDismiss?: () => void
  onClose: () => void
  onSave: (draft: ServerDraft) => Promise<void>
}

export function ServerForm({ initial, defaultRemoteHistoryEnabled = true, showGuide = true, onGuideDismiss, onClose, onSave }: ServerFormProps) {
  const [draft, setDraft] = useState<ServerDraft>({
    id: initial?.id,
    name: initial?.name ?? '',
    location: initial?.location ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    username: initial?.username ?? '',
    sshAlias: initial?.sshAlias ?? '',
    identityFile: initial?.identityFile ?? '',
    proxyJump: initial?.proxyJump ?? '',
    tags: initial?.tags ?? [],
    samplingIntervalSeconds: 2,
    historyRetentionDays: 90,
    remoteHistoryEnabled: initial?.remoteHistoryEnabled ?? defaultRemoteHistoryEnabled,
    authMethod: initial?.authMethod ?? 'sshAgent',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [passwordAcknowledged, setPasswordAcknowledged] = useState(false)
  const [setupCopied, setSetupCopied] = useState(false)
  const [setupCopyAttempted, setSetupCopyAttempted] = useState(false)
  const [dismissGuide, setDismissGuide] = useState(false)
  const [guideOpen, setGuideOpen] = useState(!initial?.id && showGuide)

  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const setupPlatform = /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix'
  const setupTarget = { username: draft.username, host: draft.host, port: draft.port }
  const setupScript = setupPlatform === 'unix' ? unixSshSetupScript(setupTarget) : windowsSshSetupScript(setupTarget)
  const setupValidationMessage = setupCopyAttempted ? sshSetupTargetValidationMessage(setupTarget) : null

  async function copySetupScript() {
    const validationMessage = sshSetupTargetValidationMessage(setupTarget)
    if (validationMessage) {
      setSetupCopyAttempted(true)
      setSetupCopied(false)
      return
    }
    try {
      await navigator.clipboard.writeText(setupScript)
      setSetupCopyAttempted(false)
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
      if (!initial?.id && dismissGuide) onGuideDismiss?.()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  if (guideOpen) {
    return (
      <Modal onClose={onClose} labelledBy="ssh-onboarding-title">
        <section className="sheet ssh-onboarding-sheet">
          <header className="sheet__header">
            <div><p className="eyebrow">首次连接</p><h2 id="ssh-onboarding-title">推荐使用 SSH 密钥</h2></div>
            <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
          </header>
          <div className="ssh-onboarding__body">
            <div className="ssh-onboarding__lead"><span><KeyRound size={22} /></span><div><strong>Ed25519 密钥 + SSH Agent</strong><p>不在 RackTop 中保存服务器密码，终端和监控连接可复用同一份系统 SSH 凭据。</p></div><em>推荐</em></div>
            <ol className="ssh-onboarding__steps">
              <li><span>1</span><div><strong>填写连接地址</strong><p>输入服务器 IP、端口和用户名；物理位置只用于现场查找机器。</p></div></li>
              <li><span>2</span><div><strong>复制快速配置</strong><p>在认证方式下展开“SSH 密钥快速配置”，复制为当前服务器生成的整段命令。</p></div></li>
              <li><span>3</span><div><strong>在本机终端执行</strong><p>命令会在缺少密钥时创建 Ed25519 密钥、写入服务器并测试免密连接，再返回 RackTop 保存。</p></div></li>
            </ol>
            <div className="ssh-onboarding__notes"><span><Terminal size={16} /><p><strong>已有 SSH 配置？</strong>可直接选择 SSH Agent、私钥或 SSH Config。首次连接仍需核对 Host Key 指纹。</p></span><label><input type="checkbox" checked={dismissGuide} onChange={(event) => setDismissGuide(event.target.checked)} />以后新增服务器时直接进入表单</label></div>
          </div>
          <footer className="sheet__footer"><button type="button" className="button button--secondary" onClick={() => setGuideOpen(false)}>已有配置，直接填写</button><button type="button" className="button button--primary" onClick={() => setGuideOpen(false)}>开始配置<ArrowRight size={16} /></button></footer>
        </section>
      </Modal>
    )
  }

  return (
    <Modal onClose={onClose} labelledBy="server-form-title">
      <section className="sheet server-form-sheet">
        <header className="sheet__header">
          <div>
            <p className="eyebrow">SSH 服务器</p>
            <h2 id="server-form-title">{initial?.id ? '编辑服务器' : '添加服务器'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <form onSubmit={submit} className="server-form">
          <div className="server-form__body">
            <div className="form-grid form-grid--2">
              <label>显示名称<input value={draft.name} onChange={(event) => set('name', event.target.value)} placeholder="训练服务器 A" /></label>
              <label>服务器位置<input value={draft.location ?? ''} onChange={(event) => set('location', event.target.value)} placeholder="例如：实验室 301 / R2 机架 / U18" /></label>
            </div>
            <div className="form-grid form-grid--host">
              <label>主机地址<input required aria-invalid={setupCopyAttempted && !draft.host.trim()} value={draft.host} onChange={(event) => set('host', event.target.value)} placeholder="10.0.0.10" /></label>
              <label>端口<input required type="number" min="1" max="65535" value={draft.port} onChange={(event) => set('port', Number(event.target.value))} /></label>
              <label>用户名<input required aria-invalid={setupCopyAttempted && !draft.username.trim()} value={draft.username} onChange={(event) => set('username', event.target.value)} placeholder="researcher" /></label>
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
            {draft.authMethod === 'sshConfig' && (
              <label>SSH Config 别名<input value={draft.sshAlias ?? ''} onChange={(event) => set('sshAlias', event.target.value)} placeholder="~/.ssh/config 中的 Host，例如 gpu-a" /></label>
            )}
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
            <details className="key-guide">
              <summary>
                <span className="key-guide__summary-icon"><KeyRound size={17} /></span>
                <span className="key-guide__summary-copy"><strong>SSH 密钥快速配置</strong><small>生成并复制当前服务器的免密登录命令</small></span>
                <ChevronRight className="key-guide__chevron" size={16} aria-hidden="true" />
              </summary>
              <div className="key-guide__toolbar">
                <span className="key-guide__platform-label">已检测：{setupPlatform === 'windows' ? '本机 Windows PowerShell → 远程 Linux' : '本机 macOS Terminal → 远程 Linux'}</span>
                <button type="button" className="button button--secondary button--small" onClick={() => void copySetupScript()}>{setupCopied ? <Check size={13} /> : <Copy size={13} />}{setupCopied ? '已复制' : '复制整段'}</button>
              </div>
              {setupValidationMessage && <p className="key-guide__validation" role="alert"><AlertTriangle size={14} />{setupValidationMessage}</p>}
              <pre><code>{setupScript}</code></pre>
            </details>
            <div className="form-grid form-grid--2">
              <label>跳板机 ProxyJump<input value={draft.proxyJump ?? ''} onChange={(event) => set('proxyJump', event.target.value)} placeholder="可选" /></label>
              <label>标签<input value={draft.tags.join(', ')} onChange={(event) => set('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} placeholder="lab, h100" /></label>
            </div>
            <label className="switch-row remote-history-row"><Database size={18} /><span><strong>服务器远端缓存 30 天</strong><small>固定保留 30 天；RackTop 关闭期间继续采集，重新打开后同步到本机 90 天历史。不保存进程和命令。</small></span><input type="checkbox" checked={draft.remoteHistoryEnabled} onChange={(event) => set('remoteHistoryEnabled', event.target.checked)} /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="sheet__footer">
            <button type="button" className="button button--secondary" data-modal-close>取消</button>
            <button type="submit" className="button button--primary" disabled={saving || (draft.authMethod === 'password' && !passwordAcknowledged)}>
              <Check size={17} />{saving ? '保存中…' : '保存并连接'}
            </button>
          </footer>
        </form>
      </section>
    </Modal>
  )
}
