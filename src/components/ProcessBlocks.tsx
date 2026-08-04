import { Fragment, useEffect, useState } from 'react'
import { CheckCircle2, ChevronUp, Cpu, OctagonX, TerminalSquare } from 'lucide-react'
import type { CpuProcessMetric, ProcessMetric, Snapshot } from '../types/models'
import { formatGpuProcessMemory } from '../utils/gpu'
import { cpuChildrenOfGpu, cpuProcessRelation, gpuProcessRelation } from '../utils/processRelations'

type ProcessSelection = { kind: 'gpu'; pid: number } | { kind: 'cpu'; pid: number } | null
export type ProcessTerminationTarget = { kind: 'gpu' | 'cpu'; process: ProcessMetric | CpuProcessMetric }

function formatMemory(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 ** 2
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
}

function canTerminate(process: ProcessMetric | CpuProcessMetric) {
  return process.isCurrentUser && process.isGroupLeader
}

function ProcessHeader({ kind, count, selected, onRequestTerminate }: { kind: 'gpu' | 'cpu'; count: number; selected?: ProcessMetric | CpuProcessMetric; onRequestTerminate?: () => void }) {
  return <header className="panel__header process-block__header"><div><span>{kind === 'gpu' ? <TerminalSquare /> : <Cpu />}</span><div><h3>{kind === 'gpu' ? 'GPU 进程' : 'CPU 进程'}</h3><p>{kind === 'gpu' ? `${count} 个计算进程 · 显示父子关系` : `${count} 个非系统进程 · 内存大于 1 GB`}</p></div></div>{selected && onRequestTerminate && <button className="button button--danger button--small" onClick={onRequestTerminate}><OctagonX size={15} />结束进程</button>}</header>
}

function EmptyProcessBlock({ kind }: { kind: 'gpu' | 'cpu' }) {
  return <div className="inline-empty process-block__empty"><CheckCircle2 size={22} /><strong>当前没有{kind === 'gpu' ? ' GPU 计算' : '可显示的 CPU'}进程</strong></div>
}

function ProcessInlineDetails({ process, kind, snapshot, onClose }: { process: ProcessMetric | CpuProcessMetric; kind: 'gpu' | 'cpu'; snapshot: Snapshot; onClose: () => void }) {
  const relation = kind === 'gpu' ? gpuProcessRelation(process as ProcessMetric, snapshot) : cpuProcessRelation(process as CpuProcessMetric, snapshot)
  return <div className="process-inline-inspector" aria-label={`进程 ${process.pid} 详情`}><header><div><strong>进程详情</strong><span>{kind.toUpperCase()} · PID {process.pid} · {relation}</span></div><button type="button" className="process-inspector__collapse" aria-label="收起进程详情" onClick={onClose}><ChevronUp size={14} /><span>收起</span></button></header><dl className="process-inspector__facts"><div><dt>父进程</dt><dd className="mono">PID {process.parentPid || '—'}</dd></div><div><dt>用户</dt><dd>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</dd></div>{kind === 'gpu' ? <><div><dt>GPU</dt><dd>GPU {(process as ProcessMetric).gpuIndex}</dd></div><div><dt>GPU 显存</dt><dd>{formatGpuProcessMemory((process as ProcessMetric).memoryUsedMb)}</dd></div><div><dt>SM 活跃率</dt><dd>{((process as ProcessMetric).smUtilization ?? 0).toFixed(0)}%</dd></div></> : <><div><dt>CPU</dt><dd>{process.cpuPercent.toFixed(1)}%</dd></div><div><dt>系统内存</dt><dd>{(process as CpuProcessMetric).memoryPercent.toFixed(1)}% · {formatMemory((process as CpuProcessMetric).memoryUsedBytes)}</dd></div></>}<div><dt>运行时间</dt><dd>{process.elapsed}</dd></div></dl><div className="process-inspector__command"><span>命令</span><code>{process.command}</code></div></div>
}

function TerminateCell({ process, checked, onCheck }: { process: ProcessMetric | CpuProcessMetric; checked: boolean; onCheck: () => void }) {
  return <td className="process-select-cell" onClick={(event) => event.stopPropagation()}>{canTerminate(process) ? <input type="checkbox" checked={checked} aria-label={`选择结束 PID ${process.pid}`} onChange={onCheck} /> : <span aria-hidden="true" />}</td>
}

function ProcessRelation({ process, kind, snapshot }: { process: ProcessMetric | CpuProcessMetric; kind: 'gpu' | 'cpu'; snapshot: Snapshot }) {
  const fullLabel = kind === 'gpu' ? gpuProcessRelation(process as ProcessMetric, snapshot) : cpuProcessRelation(process as CpuProcessMetric, snapshot)
  if (kind === 'gpu') {
    const gpuProcess = process as ProcessMetric
    const children = cpuChildrenOfGpu(gpuProcess, snapshot.cpuProcesses)
    if (children.length === 1) return <span className="process-relation" aria-label={fullLabel}><span>CPU 子进程</span><span className="mono">PID {children[0].pid}</span></span>
    if (children.length > 1) return <span className="process-relation" aria-label={fullLabel}><span>{children.length} 个 CPU 子进程</span></span>
  }
  const gpuParent = snapshot.processes.find((candidate) => candidate.pid === process.parentPid)
  if (gpuParent) return <span className="process-relation" aria-label={fullLabel}><span>GPU {gpuParent.gpuIndex}</span><span className="mono">PID {gpuParent.pid}</span><small>子进程</small></span>
  const cpuParent = snapshot.cpuProcesses.find((candidate) => candidate.pid === process.parentPid)
  if (cpuParent) return <span className="process-relation" aria-label={fullLabel}><span>CPU</span><span className="mono">PID {cpuParent.pid}</span><small>子进程</small></span>
  return <span className="process-relation" aria-label={fullLabel}><span>父进程</span><span className="mono">PID {process.parentPid || '—'}</span></span>
}

function ProcessColGroup({ kind, compact }: { kind: 'gpu' | 'cpu'; compact: boolean }) {
  return <colgroup><col className="process-col--select" />{kind === 'gpu' && <col className="process-col--gpu" />}<col className="process-col--pid" /><col className="process-col--relation" /><col className="process-col--user" /><col className="process-col--command" /><col className={kind === 'gpu' ? 'process-col--gpu-memory' : 'process-col--cpu'} />{!compact && <><col className={kind === 'gpu' ? 'process-col--cpu' : 'process-col--system-memory'} /><col className="process-col--elapsed" /></>}</colgroup>
}

function GpuProcessRows({ processes, snapshot, selection, terminateSelection, onSelect, onTerminateSelect, compact }: { processes: ProcessMetric[]; snapshot: Snapshot; selection: ProcessSelection; terminateSelection: ProcessSelection; onSelect: (selection: ProcessSelection) => void; onTerminateSelect: (selection: ProcessSelection) => void; compact: boolean }) {
  return <tbody>{processes.map((process) => {
    const selected = selection?.kind === 'gpu' && selection.pid === process.pid
    const checked = terminateSelection?.kind === 'gpu' && terminateSelection.pid === process.pid
    return <Fragment key={`${process.gpuUuid}-${process.pid}`}><tr tabIndex={0} aria-selected={selected} className={`${process.isCurrentUser ? 'is-current-user' : ''} ${selected ? 'is-selected' : ''}`} onClick={() => onSelect({ kind: 'gpu', pid: process.pid })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'gpu', pid: process.pid }) } }}><TerminateCell process={process} checked={checked} onCheck={() => onTerminateSelect(checked ? null : { kind: 'gpu', pid: process.pid })} /><td>GPU {process.gpuIndex}</td><td className="mono">{process.pid}</td><td><ProcessRelation process={process} kind="gpu" snapshot={snapshot} /></td><td>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</td><td className="process-command" title={process.command}>{process.command}</td><td>{formatGpuProcessMemory(process.memoryUsedMb)}</td>{!compact && <><td>{process.cpuPercent.toFixed(1)}%</td><td>{process.elapsed}</td></>}</tr>{selected && <tr className="process-detail-row"><td colSpan={compact ? 7 : 9}><ProcessInlineDetails process={process} kind="gpu" snapshot={snapshot} onClose={() => onSelect(null)} /></td></tr>}</Fragment>
  })}</tbody>
}

function CpuProcessRows({ processes, snapshot, selection, terminateSelection, onSelect, onTerminateSelect, compact }: { processes: CpuProcessMetric[]; snapshot: Snapshot; selection: ProcessSelection; terminateSelection: ProcessSelection; onSelect: (selection: ProcessSelection) => void; onTerminateSelect: (selection: ProcessSelection) => void; compact: boolean }) {
  return <tbody>{processes.map((process) => {
    const selected = selection?.kind === 'cpu' && selection.pid === process.pid
    const checked = terminateSelection?.kind === 'cpu' && terminateSelection.pid === process.pid
    return <Fragment key={process.pid}><tr tabIndex={0} aria-selected={selected} className={`${process.isCurrentUser ? 'is-current-user' : ''} ${selected ? 'is-selected' : ''}`} onClick={() => onSelect({ kind: 'cpu', pid: process.pid })} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect({ kind: 'cpu', pid: process.pid }) } }}><TerminateCell process={process} checked={checked} onCheck={() => onTerminateSelect(checked ? null : { kind: 'cpu', pid: process.pid })} /><td className="mono">{process.pid}</td><td><ProcessRelation process={process} kind="cpu" snapshot={snapshot} /></td><td>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</td><td className="process-command" title={process.command}>{process.command}</td><td>{process.cpuPercent.toFixed(1)}%</td>{!compact && <><td>{process.memoryPercent.toFixed(1)}% · {formatMemory(process.memoryUsedBytes)}</td><td>{process.elapsed}</td></>}</tr>{selected && <tr className="process-detail-row"><td colSpan={compact ? 6 : 8}><ProcessInlineDetails process={process} kind="cpu" snapshot={snapshot} onClose={() => onSelect(null)} /></td></tr>}</Fragment>
  })}</tbody>
}

export function ProcessBlocks({ snapshot, compact = false, onRequestTerminate }: { snapshot: Snapshot; compact?: boolean; onRequestTerminate?: (target: ProcessTerminationTarget) => void }) {
  const [selection, setSelection] = useState<ProcessSelection>(null)
  const [terminateSelection, setTerminateSelection] = useState<ProcessSelection>(null)
  useEffect(() => {
    if (selection) {
      const exists = selection.kind === 'gpu' ? snapshot.processes.some((process) => process.pid === selection.pid) : snapshot.cpuProcesses.some((process) => process.pid === selection.pid)
      if (!exists) setSelection(null)
    }
    if (terminateSelection) {
      const process = terminateSelection.kind === 'gpu' ? snapshot.processes.find((item) => item.pid === terminateSelection.pid) : snapshot.cpuProcesses.find((item) => item.pid === terminateSelection.pid)
      if (!process || !canTerminate(process)) setTerminateSelection(null)
    }
  }, [selection, snapshot.cpuProcesses, snapshot.processes, terminateSelection])
  const gpuProcesses = compact ? snapshot.processes.slice(0, 5) : snapshot.processes
  const cpuProcesses = compact ? snapshot.cpuProcesses.slice(0, 5) : snapshot.cpuProcesses
  const selectedGpu = terminateSelection?.kind === 'gpu' ? snapshot.processes.find((process) => process.pid === terminateSelection.pid) : undefined
  const selectedCpu = terminateSelection?.kind === 'cpu' ? snapshot.cpuProcesses.find((process) => process.pid === terminateSelection.pid) : undefined

  return <div className={`process-blocks ${compact ? 'process-blocks--compact' : ''}`}>
    <section className="panel process-panel"><ProcessHeader kind="gpu" count={snapshot.processes.length} selected={selectedGpu} onRequestTerminate={selectedGpu && onRequestTerminate ? () => onRequestTerminate({ kind: 'gpu', process: selectedGpu }) : undefined} />{gpuProcesses.length ? <div className="table-scroll"><table className="process-table process-table--gpu"><ProcessColGroup kind="gpu" compact={compact} /><thead><tr><th aria-label="选择" /><th>GPU</th><th>PID</th><th>关系</th><th>用户</th><th>命令</th><th>显存</th>{!compact && <><th>CPU</th><th>运行时间</th></>}</tr></thead><GpuProcessRows processes={gpuProcesses} snapshot={snapshot} selection={selection} terminateSelection={terminateSelection} onSelect={setSelection} onTerminateSelect={setTerminateSelection} compact={compact} /></table></div> : <EmptyProcessBlock kind="gpu" />}{compact && snapshot.processes.length > gpuProcesses.length && <p className="process-block__more">另有 {snapshot.processes.length - gpuProcesses.length} 个 GPU 进程，请在“进程”页查看</p>}</section>
    <section className="panel process-panel"><ProcessHeader kind="cpu" count={snapshot.cpuProcesses.length} selected={selectedCpu} onRequestTerminate={selectedCpu && onRequestTerminate ? () => onRequestTerminate({ kind: 'cpu', process: selectedCpu }) : undefined} />{cpuProcesses.length ? <div className="table-scroll"><table className="process-table process-table--cpu"><ProcessColGroup kind="cpu" compact={compact} /><thead><tr><th aria-label="选择" /><th>PID</th><th>关系</th><th>用户</th><th>命令</th><th>CPU</th>{!compact && <><th>系统内存</th><th>运行时间</th></>}</tr></thead><CpuProcessRows processes={cpuProcesses} snapshot={snapshot} selection={selection} terminateSelection={terminateSelection} onSelect={setSelection} onTerminateSelect={setTerminateSelection} compact={compact} /></table></div> : <EmptyProcessBlock kind="cpu" />}{compact && snapshot.cpuProcesses.length > cpuProcesses.length && <p className="process-block__more">另有 {snapshot.cpuProcesses.length - cpuProcesses.length} 个 CPU 进程，请在“进程”页查看</p>}</section>
  </div>
}
