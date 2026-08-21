import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { AlertCircle, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { api } from '../services/api'
import { analyzeCudaCommand } from '../utils/cudaCommand'
import { bracketTerminalPaste, isMultilineTerminalPaste, normalizeTerminalPaste } from '../utils/terminalPaste'

interface TerminalEvent { sessionId: string; data?: string }

export function SshTerminal({ serverId, serverName, gpuIndex, acceleratorVendor = 'nvidia', onNotice }: { serverId: string; serverName: string; gpuIndex?: number; acceleratorVendor?: 'nvidia' | 'ascend'; onNotice?: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | null>(null)
  const lineRef = useRef('')
  const pendingEnterRef = useRef(false)
  const [status, setStatus] = useState<'connecting' | 'connected' | 'closed' | 'error'>(api.isDesktop ? 'connecting' : 'closed')
  const [error, setError] = useState<string | null>(null)
  const [restart, setRestart] = useState(0)
  const [confirmation, setConfirmation] = useState<string | null>(null)

  useEffect(() => {
    if (!api.isDesktop || !containerRef.current) return
    let disposed = false
    const terminal = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.3, scrollback: 5000, theme: { background: '#101114', foreground: '#e7e8ea', cursor: '#79aaff', selectionBackground: '#45658a88' } })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(containerRef.current)
    fit.fit()
    terminal.focus()
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

    const decode = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    const outputListener = listen<TerminalEvent>('terminal-output', ({ payload }) => {
      if (payload.sessionId === sessionRef.current && payload.data) terminal.write(decode(payload.data))
    })
    const exitListener = listen<TerminalEvent>('terminal-exit', ({ payload }) => {
      if (payload.sessionId === sessionRef.current) { setStatus('closed'); terminal.write('\r\n\x1b[90m[会话已断开]\x1b[0m\r\n') }
    })

    const send = (data: string) => { const id = sessionRef.current; if (id) void api.writeTerminal(id, data).catch((reason) => setError(String(reason))) }
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
    containerRef.current.addEventListener('paste', handlePaste, true)
    const dataDisposable = terminal.onData((data) => {
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
    void api.startTerminal(serverId, terminal.cols, terminal.rows, gpuIndex, acceleratorVendor).then((id) => {
      if (disposed) { void api.closeTerminal(id); return }
      sessionRef.current = id
      setStatus('connected')
      fit.fit()
      void api.resizeTerminal(id, terminal.cols, terminal.rows)
      fitAndResize()
      terminal.focus()
    }).catch((reason) => { setStatus('error'); setError(String(reason)) })

    return () => {
      disposed = true
      if (fitFrame !== null) cancelAnimationFrame(fitFrame)
      resize.disconnect()
      containerRef.current?.removeEventListener('paste', handlePaste, true)
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

  if (!api.isDesktop) return <section className="panel terminal-unavailable"><SquareTerminal size={28} /><h3>终端在桌面 App 中可用</h3><p>网页演示不会建立或伪造 SSH 会话。</p></section>
  return <section className="terminal-shell" aria-label={`${serverName} SSH 终端`}>
    <header><span className={`terminal-status terminal-status--${status}`} /><strong>{gpuIndex === undefined ? serverName : `${serverName} · GPU ${gpuIndex}`}</strong><small>{status === 'connecting' ? '正在连接' : status === 'connected' ? '已连接' : status === 'error' ? '连接失败' : '已断开'}</small><button className="icon-button" aria-label="重新连接终端" title="重新连接" onClick={() => { setError(null); setStatus('connecting'); setRestart((value) => value + 1) }}><RefreshCw size={14} /></button></header>
    {error && <div className="terminal-error" role="alert"><AlertCircle size={15} /><span>{error}</span><button onClick={() => setError(null)} aria-label="关闭错误"><X size={13} /></button></div>}
    <div className="terminal-canvas" ref={containerRef} />
    {confirmation && <div className="terminal-confirm" role="alertdialog" aria-modal="true"><div><strong>确认 GPU 绑定</strong><p>{confirmation}。命令仍停留在远端输入行，尚未执行。</p></div><button className="button button--secondary button--small" onClick={() => confirmPending(false)}>暂不执行</button><button className="button button--primary button--small" onClick={() => confirmPending(true)}>仍然执行</button></div>}
  </section>
}
