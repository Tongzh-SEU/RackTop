import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, ArrowUpFromLine, CheckCircle2, FileCode2, FileInput, FileJson, FileOutput, KeyRound, LockKeyhole, LoaderCircle, X } from 'lucide-react'
import { api } from '../services/api'
import type { Server, ServerConfigImportPreview, ServerDraft } from '../types/models'
import { duplicateImportIndexes } from '../utils/serverIdentity'
import './ConfigTransferMenu.css'

interface ConfigTransferMenuProps {
  servers: Server[]
  onImported: (count: number) => Promise<void>
  onNotice: (message: string) => void
}

type Dialog = 'export' | 'import' | null

function blockedReason(draft: ServerDraft): string | undefined {
  return !draft.sshHops?.length && draft.proxyJump?.trim() && draft.proxyJump.trim().toLowerCase() !== 'none'
    ? '跳板机需在目标电脑重新配置' : undefined
}

export function ConfigTransferMenu({ servers, onImported, onNotice }: ConfigTransferMenuProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [panelPosition, setPanelPosition] = useState({ left: 12, bottom: 12, maxHeight: 'calc(100vh - 24px)' })
  const [exportKind, setExportKind] = useState<'racktop' | 'ssh'>('racktop')
  const [importKind, setImportKind] = useState<'racktop' | 'ssh'>('racktop')
  const [plainDrafts, setPlainDrafts] = useState<ServerDraft[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportPassword, setExportPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [importPassword, setImportPassword] = useState('')
  const [packageContents, setPackageContents] = useState('')
  const [filename, setFilename] = useState('')
  const [preview, setPreview] = useState<ServerConfigImportPreview | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [draggingFile, setDraggingFile] = useState(false)
  const keyCount = servers.filter((server) => server.identityFile && (server.authMethod === 'privateKey' || server.authMethod === 'sshConfig')).length
  const duplicates = useMemo(
    () => duplicateImportIndexes(preview?.servers.map(({ draft }) => draft) ?? plainDrafts ?? [], servers),
    [preview, plainDrafts, servers],
  )
  const reviewServers = preview?.servers.map((item) => ({ ...item, blockedReason: item.blockedReason || blockedReason(item.draft) })) ?? plainDrafts?.map((draft) => ({ draft, includesPrivateKey: false, blockedReason: blockedReason(draft) }))
  const unavailable = new Set(reviewServers?.flatMap((item, index) => duplicates.has(index) || item.blockedReason ? [index] : []) ?? [])
  const availableCount = (reviewServers?.length ?? 0) - unavailable.size
  const selectedCount = [...selected].filter((index) => !unavailable.has(index)).length

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  useLayoutEffect(() => {
    if (!dialog && !menuOpen) return
    const surface = dialog ? dialogRef.current : menuRef.current
    const trigger = anchorRef.current
    const sidebar = trigger?.closest<HTMLElement>('.sidebar') ?? trigger
    if (!surface || !sidebar) return
    const place = () => {
      const origin = sidebar.getBoundingClientRect()
      const scale = sidebar.offsetWidth > 0 ? origin.width / sidebar.offsetWidth : 1
      const panel = surface.getBoundingClientRect()
      // Match the sidebar footer's shared bottom-left anchor across menu and dialogs.
      const left = Math.max(12, Math.min(origin.right + 18 * scale, window.innerWidth - panel.width - 12))
      const bottomEdge = Math.max(12, origin.bottom - 27 * scale)
      const bottom = window.innerHeight - bottomEdge
      const maxHeight = `${Math.max(0, bottomEdge - 12)}px`
      setPanelPosition((current) => current.left === left && current.bottom === bottom && current.maxHeight === maxHeight ? current : { left, bottom, maxHeight })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    observer?.observe(surface)
    observer?.observe(sidebar)
    const shell = sidebar.closest('.app-shell')
    const zoomObserver = new MutationObserver(place)
    if (shell) zoomObserver.observe(shell, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', place)
    return () => { observer?.disconnect(); zoomObserver.disconnect(); window.removeEventListener('resize', place) }
  }, [dialog, menuOpen])

  useEffect(() => {
    if (!dialog) return
    return () => triggerRef.current?.focus()
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    dialogRef.current?.querySelector<HTMLElement>('[data-transfer-focus]')?.focus()
  }, [dialog, filename, preview, plainDrafts])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (dialog) { event.stopPropagation(); closeDialog() }
        else if (menuOpen) { setMenuOpen(false); triggerRef.current?.focus() }
      }
      if (dialog && event.key === 'Tab') {
        const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden])') ?? [])]
        const first = items[0]
        const last = items[items.length - 1]
        if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  function resetImport() {
    if (preview) void api.discardServerConfigImport(preview.importId).catch(() => {})
    setImportPassword('')
    setPackageContents('')
    setFilename('')
    setPreview(null)
    setPlainDrafts(null)
    setSelected(new Set())
    setDraggingFile(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function closeDialog(force = false) {
    if (busy && !force) return
    setDialog(null)
    setError(null)
    setExportPassword('')
    setConfirmPassword('')
    resetImport()
  }

  function openExport(kind: 'racktop' | 'ssh') {
    setMenuOpen(false)
    setError(null)
    setExportKind(kind)
    setDialog('export')
  }

  function openImport(kind: 'racktop' | 'ssh') {
    setMenuOpen(false)
    setImportKind(kind)
    resetImport()
    setError(null)
    setDialog('import')
  }

  async function exportConfig() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.exportServerConfig(exportKind === 'ssh' ? '' : exportPassword, exportKind)
      if (!result) return
      closeDialog(true)
      onNotice(exportKind === 'ssh' ? `已导出 ${result.serverCount} 台 SSH Config` : `已加密导出 ${result.serverCount} 台配置，包含 ${result.privateKeyCount} 把私钥`)
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function readPackage(file?: File) {
    if (!file || busy) return
    resetImport()
    setError(null)
    if (file.size > 32 * 1024 * 1024) {
      setError('配置包超过 32 MB，无法导入')
      return
    }
    setBusy(true)
    try {
      const contents = await file.text()
      if (importKind === 'ssh') {
        if (contents.trimStart().startsWith('{')) throw new Error('加密配置包请使用“导入配置”')
        // A selected file is not necessarily this device's ~/.ssh/config.
        const drafts = (await api.parseSshConfig(contents)).map((draft) => ({ ...draft, sshAlias: undefined, identityFile: undefined, authMethod: 'sshAgent' as const }))
        if (drafts.length === 0) throw new Error('没有找到可导入的具体 Host')
        setPlainDrafts(drafts)
        const foundDuplicates = duplicateImportIndexes(drafts, servers)
        drafts.forEach((draft, index) => { if (blockedReason(draft)) foundDuplicates.add(index) })
        setSelected(new Set(drafts.map((_, index) => index).filter((index) => !foundDuplicates.has(index))))
      } else {
        setPackageContents(contents)
      }
      setFilename(file.name)
    } catch (reason) {
      setError(`无法读取配置包：${String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  async function verifyImport() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.prepareServerConfigImport(packageContents, importPassword)
      const foundDuplicates = duplicateImportIndexes(result.servers.map(({ draft }) => draft), servers)
      result.servers.forEach((item, index) => { if (item.blockedReason || blockedReason(item.draft)) foundDuplicates.add(index) })
      setPreview(result)
      setImportPassword('')
      setPackageContents('')
      setSelected(new Set(result.servers.map((_, index) => index).filter((index) => !foundDuplicates.has(index))))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(false)
    }
  }

  async function confirmImport() {
    if (!preview && !plainDrafts) return
    const selectedIndexes = [...selected].filter((index) => !unavailable.has(index))
    setBusy(true)
    setError(null)
    try {
      const result = preview ? await api.commitServerConfigImport(preview.importId, selectedIndexes) : await (async () => {
        let importedCount = 0
        for (const index of selectedIndexes) { await api.saveServer(plainDrafts![index]); importedCount += 1 }
        return { importedCount }
      })()
      setPreview(null)
      setDialog(null)
      resetImport()
      await onImported(result.importedCount)
    } catch (reason) {
      setError(String(reason))
      // A batch can have committed earlier rows before a later save fails.
      // Reconcile against persisted state before allowing the next attempt.
      try {
        const current = await api.listServers()
        const imported = duplicateImportIndexes(reviewServers?.map(({ draft }) => draft) ?? [], current)
        setSelected(new Set(selectedIndexes.filter((index) => !imported.has(index))))
        await onImported(selectedIndexes.filter((index) => imported.has(index)).length)
      } catch (refreshError) {
        setSelected(new Set())
        setError(String(reason) + '；无法刷新已导入记录，请重新打开导入：' + String(refreshError))
      }
    } finally {
      setBusy(false)
    }
  }

  const dialogTitle = dialog === 'export'
    ? exportKind === 'ssh' ? '导出 SSH Config' : '导出 RackTop 配置'
    : reviewServers ? '确认导入' : packageContents ? '导入加密配置包' : importKind === 'ssh' ? '导入 SSH Config' : '导入 RackTop 配置'

  return <div className="config-transfer-anchor" ref={anchorRef}>
    <button ref={triggerRef} className={`config-transfer-trigger ${menuOpen ? 'is-open' : ''}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); setMenuOpen(true); requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()) }
    }}><ArrowLeftRight size={16} />导入 / 导出配置</button>
    {menuOpen && createPortal(<div ref={menuRef} style={panelPosition} className="config-transfer-popover" role="menu" aria-label="配置导入与导出" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[next]?.focus()
    }}>
      <p className="config-transfer-popover__heading">RackTop 配置<span className="config-transfer-recommended">推荐</span></p>
      <button role="menuitem" disabled={servers.length === 0} onClick={() => openExport('racktop')}><span className="config-transfer-menu-icon"><FileOutput size={17} strokeWidth={1.6} /></span><span><strong>导出配置</strong></span><kbd>.json</kbd></button>
      <button role="menuitem" aria-label="导入配置" onClick={() => openImport('racktop')}><span className="config-transfer-menu-icon"><FileInput size={17} strokeWidth={1.6} /></span><span><strong>导入配置</strong></span></button>
      <div className="config-transfer-popover__divider" />
      <p className="config-transfer-popover__heading">SSH 配置</p>
      <button role="menuitem" aria-label="导出 SSH Config" disabled={servers.length === 0} onClick={() => openExport('ssh')}><span className="config-transfer-menu-icon"><FileOutput size={17} strokeWidth={1.6} /></span><span><strong>导出 SSH Config</strong></span><kbd>config</kbd></button>
      <button role="menuitem" aria-label="导入 SSH Config" onClick={() => openImport('ssh')}><span className="config-transfer-menu-icon"><FileInput size={17} strokeWidth={1.6} /></span><span><strong>导入 SSH Config</strong></span></button>
    </div>, document.body)}

    {dialog && createPortal(<div className="transfer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDialog()}>
      <section ref={dialogRef} style={panelPosition} className="transfer-surface config-transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="config-transfer-title" aria-busy={busy}>
        <header className="transfer-header">
          <h2 id="config-transfer-title">{dialogTitle}</h2>
          <button className="icon-button" disabled={busy} onClick={() => closeDialog()} aria-label="关闭配置迁移"><X size={18} /></button>
        </header>
        <div className="transfer-body">
          {dialog === 'export' ? <>
            <p className="transfer-export-summary">{servers.length} 台服务器{exportKind === 'racktop' ? ` · ${keyCount} 把私钥` : ' · 不含密钥'}</p>
            {exportKind === 'racktop' && <form id="config-transfer-export-form" className="transfer-password-fields" onSubmit={(event) => { event.preventDefault(); if (!busy && exportPassword.length >= 8 && exportPassword === confirmPassword) void exportConfig() }}>
              <label><span>迁移密码</span><input data-transfer-focus type="password" autoComplete="new-password" minLength={8} value={exportPassword} disabled={busy} onChange={(event) => setExportPassword(event.target.value)} placeholder="至少 8 个字符" /></label>
              <label><span>确认迁移密码</span><input type="password" autoComplete="new-password" value={confirmPassword} disabled={busy} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入迁移密码" /></label>
              {confirmPassword && exportPassword !== confirmPassword && <p role="alert">两次密码不一致</p>}
            </form>}
          </> : <>
            <input ref={fileInputRef} type="file" hidden accept={importKind === 'ssh' ? undefined : '.json,application/json'} disabled={busy} onChange={(event) => void readPackage(event.currentTarget.files?.[0])} />
            {filename ? <div className="transfer-selected-file">
              {importKind === 'ssh' ? <FileCode2 size={25} /> : <FileJson size={25} />}
              <div><strong title={filename}>{filename}</strong><small>{plainDrafts ? 'SSH Config' : '加密配置包'}</small></div>
              <button className="icon-button" disabled={busy} onClick={() => { resetImport(); setError(null) }} aria-label="移除已选文件"><X size={16} /></button>
            </div> : <div className={`transfer-dropzone ${draggingFile ? 'is-dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); if (!busy) setDraggingFile(true) }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFile(false) }} onDrop={(event) => { event.preventDefault(); setDraggingFile(false); void readPackage(event.dataTransfer.files[0]) }}>
              <span><ArrowUpFromLine size={23} /></span>
              <strong>把配置文件拖到这里</strong>
              <button data-transfer-focus className="button button--secondary" disabled={busy} onClick={() => fileInputRef.current?.click()}>{busy ? '正在读取…' : '选择文件'}</button>
            </div>}
            {packageContents && !reviewServers && <form className="transfer-password-fields transfer-import-password" onSubmit={(event) => { event.preventDefault(); if (!busy && importPassword.length >= 8) void verifyImport() }}>
              <label><span>迁移密码</span><input data-transfer-focus type="password" autoComplete="current-password" value={importPassword} disabled={busy} onChange={(event) => setImportPassword(event.target.value)} placeholder="输入导出时设置的密码" /></label>
            </form>}
            {reviewServers && <>
              <div className="transfer-review-summary"><CheckCircle2 size={18} /><p>{reviewServers.length} 台服务器{preview ? ` · ${preview.privateKeyCount} 把私钥` : ''}{duplicates.size > 0 ? ` · ${duplicates.size} 台已存在，已跳过` : ''}</p></div>
              <div className="transfer-import-servers">{reviewServers.map(({ draft, includesPrivateKey, blockedReason: reason }, index) => {
                const duplicate = duplicates.has(index)
                return <label className={duplicate || reason ? 'is-duplicate' : ''} key={`${draft.host}:${draft.port}:${draft.username}:${index}`}>
                  <input data-transfer-focus={!duplicate && !reason || undefined} type="checkbox" checked={selected.has(index) && !unavailable.has(index)} disabled={unavailable.has(index) || busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next })} />
                  <span><strong>{draft.sshAlias || draft.name || draft.host}</strong><small>{draft.username}@{draft.host}:{draft.port}{draft.proxyJump ? ` · via ${draft.proxyJump}` : ''}</small>{reason && <small>{reason}</small>}</span>
                  {includesPrivateKey && <KeyRound size={15} aria-label="包含私钥" />}
                  <em>{reason ? '需配置' : duplicate ? '已存在' : '新增'}</em>
                </label>
              })}</div>
            </>}
          </>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="transfer-footer">
          {dialog === 'import' && reviewServers && <span className="transfer-footer-hint">已选 {selectedCount} / {availableCount} 台</span>}
          <button className="button button--secondary" onClick={() => closeDialog()} disabled={busy}>取消</button>
          {dialog === 'export' && exportKind === 'ssh' ? <button className="button button--primary" disabled={busy} onClick={() => void exportConfig()}>导出</button> : dialog === 'export' ? <button className="button button--primary" type="submit" form="config-transfer-export-form" disabled={busy || exportPassword.length < 8 || exportPassword !== confirmPassword}>{busy ? <LoaderCircle size={15} className="spin" /> : <LockKeyhole size={15} />}加密导出</button>
            : reviewServers ? <button className="button button--primary" onClick={() => void confirmImport()} disabled={busy || selectedCount === 0}>{busy ? <LoaderCircle size={15} className="spin" /> : <CheckCircle2 size={15} />}导入 {selectedCount} 台</button>
            : <button className="button button--primary" onClick={() => void verifyImport()} disabled={busy || !packageContents || importPassword.length < 8}>{busy ? <LoaderCircle size={15} className="spin" /> : <LockKeyhole size={15} />}验证配置包</button>}
        </footer>
      </section>
    </div>, document.body)}
  </div>
}
