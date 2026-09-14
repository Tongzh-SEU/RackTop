import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AlertCircle, RefreshCw, X } from 'lucide-react'
import { createTerminalPreview } from '../utils/terminalPreview'
import { api } from '../services/api'
import { analyzeCudaCommand } from '../utils/cudaCommand'
import { bracketTerminalPaste, isMultilineTerminalPaste, normalizeTerminalPaste } from '../utils/terminalPaste'

interface TerminalEvent { sessionId: string; data?: string }

export function SshTerminal({ serverId, serverName, gpuIndex, acceleratorVendor = 'nvidia', onNotice }: { serverId: string; serverName: string; gpuIndex?: number; acceleratorVendor?: 'nvidia' | 'ascend' | 'ppu'; onNotice?: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | null>(null)
  const lineRef = useRef('')
  const pendingEnterRef = useRef(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    let disposed = false
    const terminal = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.3, scrollback: 5000, theme: { background: '#101114', foreground: '#e7e8ea', cursor: '#79aaff', selectionBackground: '#45658a88' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    fit.fit()
    terminal.focus()
    const previewInput = api.isDesktop ? null : createTerminalPreview((data) => terminal.write(data), () => terminal)
    let fitFrame: number | null = null

    const fitAndResize = () => {
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null
        if (disposed) return
        fit.fit()
        const id = sessionRef.current
        if (id) void api.resizeTerminal(id, terminal.cols, terminal.rows)
      })
    }
    const fontFit = document.fonts?.ready.then(() => fitAndResize())

    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    const outputListener = api.isDesktop ? listen<TerminalEvent>('terminal-output', ({ payload }) => {
      if (payload.sessionId === sessionRef.current && payload.data) terminal.write(decode(payload.data))
    }) : Promise.resolve(() => {})
    const exitListener = api.isDesktop ? listen<TerminalEvent>('terminal-exit', ({ payload }) => {
      if (payload.sessionId === sessionRef.current) { setStatus('closed'); terminal.write('\r\n\x1b[90m[会话已断开]\x1b[0m\r\n') }
    }) : Promise.resolve(() => {})

    const send = (data: string) => { if (previewInput) { previewInput(data); return }; const id = sessionRef.current; if (id) void api.writeTerminal(id, data).catch((reason) => setError(String(reason))) }
    const handlePaste = (event: ClipboardEvent) => {
      const pasted = event.clipboardData?.getData('text/plain') ?? ''
      if (!isMultilineTerminalPaste(pasted)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const normalized = normalizeTerminalPaste(pasted)
      lineRef.current += normalized
      send(bracketTerminalPaste(normalized))
      onNotice?.(`已整体粘贴 ${normalized.split('\n').filter(Boolean).length} 行，按回车执行`)
    }
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const selection = terminal.getSelection()
      if (!selection) return
      if (!navigator.clipboard) { onNotice?.('复制失败，请使用 ⌘C / Ctrl+C'); return }
      void navigator.clipboard.writeText(selection).then(() => onNotice?.('已复制选中的终端内容')).catch(() => onNotice?.('复制失败，请使用 ⌘C / Ctrl+C'))
    }
    containerRef.current.addEventListener('paste', handlePaste, true)
    containerRef.current.addEventListener('contextmenu', handleContextMenu, true)
    const dataDisposable = terminal.onData((data) => {
      if (previewInput) { previewInput(data); return }
      if (pendingEnterRef.current) return
      if (gpuIndex !== undefined && (data === '\r' || data === '\n')) {
        const analysis = analyzeCudaCommand(lineRef.current, gpuIndex)
        lineRef.current = ''
        if (analysis.requiresConfirmation) { pendingEnterRef.current = true; setConfirmation(analysis.message ?? '无法确认 GPU 绑定，仍要执行吗？'); return }
        if (analysis.modified) { send(`\x15${analysis.command}\r`); onNotice?.(analysis.message ?? '已修正 GPU 绑定'); return }
      } else if (data === '\x7f') lineRef.current = lineRef.current.slice(0, -1)
      else if (data === '\x15') lineRef.current = ''
      else if (!data.startsWith('\x1b') && !/^[\x00-\x1f]$/.test(data)) lineRef.current += data
      send(data)
    })

    const resize = new ResizeObserver(fitAndResize)
    resize.observe(containerRef.current)
    const started = api.isDesktop ? api.startTerminal(serverId, terminal.cols, terminal.rows, gpuIndex, acceleratorVendor) : Promise.resolve(null)
    void started.then((id) => {
      if (disposed) { if (id) void api.closeTerminal(id); return }
      sessionRef.current = id
      setStatus('connected')
      fit.fit()
      if (id) void api.resizeTerminal(id, terminal.cols, terminal.rows)
      fitAndResize()
      terminal.focus()
    }).catch((reason) => { setStatus('error'); setError(String(reason)) })

    return () => {
      disposed = true
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      void fontFit
      resize.disconnect()
      containerRef.current?.removeEventListener('paste', handlePaste, true)
      containerRef.current?.removeEventListener('contextmenu', handleContextMenu, true)
      dataDisposable.dispose()
      void outputListener.then((unlisten) => unlisten())
      void exitListener.then((unlisten) => unlisten())
      const id = sessionRef.current
      sessionRef.current = null
      if (id) void api.closeTerminal(id)
      terminal.dispose()
    }
  }, [acceleratorVendor, gpuIndex, onNotice, restart, serverId])

  const confirmPending = (sendEnter: boolean) => {
    pendingEnterRef.current = false
    setConfirmation(null)
    if (sendEnter && sessionRef.current) void api.writeTerminal(sessionRef.current, '\r')
  }

  return <section className="terminal-shell" aria-label={`${serverName} SSH 终端`}>
    <header><span className={`terminal-status terminal-status--${status}`} /><strong>{gpuIndex === undefined ? serverName : `${serverName} · GPU ${gpuIndex}`}</strong><small>{!api.isDesktop ? '本地模拟 · 无 SSH 连接' : status === 'connecting' ? '正在连接' : status === 'connected' ? '已连接' : status === 'error' ? '连接失败' : '已断开'}</small><button className="icon-button" aria-label="重新连接终端" title="重新连接" onClick={() => { setError(null); setStatus('connecting'); setRestart((value) => value + 1) }}><RefreshCw size={14} /></button></header>
    {error && <div className="terminal-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button onClick={() => setError(null)} aria-label="关闭错误"><X size={13} /></button></div>}
    <div className="terminal-canvas" ref={containerRef} />
    {confirmation && <div className="terminal-confirm" role="alertdialog" aria-modal="true"><div><strong>确认 GPU 绑定</strong><p>{confirmation}。命令仍停留在远端输入行，尚未执行。</p></div><button className="button button--secondary button--small" onClick={() => confirmPending(false)}>暂不执行</button><button className="button button--primary button--small" onClick={() => confirmPending(true)}>仍然执行</button></div>}
  </section>
}
