import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import type { Server } from '../types/models'
import { isRackTopManagedIdentity } from '../utils/sshSetup'

export function DeleteServerDialog({ server, onClose, onDelete }: { server: Server; onClose: () => void; onDelete: (revokeSshAccess: boolean) => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revokeSshAccess, setRevokeSshAccess] = useState(false)
  const canRevokeSshAccess = isRackTopManagedIdentity(server.identityFile)

  async function confirmDelete() {
    setDeleting(true)
    setError(null)
    try {
      await onDelete(revokeSshAccess)
    } catch (reason) {
      setError(String(reason))
      setDeleting(false)
    }
  }

  return (
    <div className="scrim">
      <section className="sheet delete-server-sheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-server-title">
        <header className="sheet__header">
          <div><p className="eyebrow">删除服务器</p><h2 id="delete-server-title">确认删除“{server.name}”？</h2></div>
          <button className="icon-button" onClick={onClose} disabled={deleting} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="delete-server-body">
          <span className="delete-server-icon"><Trash2 size={24} /></span>
          <div>
            <p>将从 RackTop 移除 <strong>{server.username}@{server.host}:{server.port}</strong>，并删除本机历史及本机对应的远端采集状态。</p>
            <small>其他电脑仍有关联时保留共享历史；最后一个关联删除后清理。旧版历史保留。</small>
          </div>
          {canRevokeSshAccess && (
            <label className="delete-server-revoke">
              <input type="checkbox" checked={revokeSshAccess} disabled={deleting} onChange={(event) => setRevokeSshAccess(event.target.checked)} />
              <span><strong>同时撤销 RackTop 配置的免密登录</strong><small>使用同一密钥的其他电脑也会失去此项登录授权。</small></span>
            </label>
          )}
          {error && <p className="form-error" role="alert">删除失败：{error}</p>}
        </div>
        <footer className="sheet__footer">
          <button className="button button--secondary" onClick={onClose} disabled={deleting}>取消</button>
          <button className="button button--danger" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? '删除中…' : '删除本机配置'}</button>
        </footer>
      </section>
    </div>
  )
}
