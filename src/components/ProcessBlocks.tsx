import { Fragment, memo, useEffect, useState } from 'react'
import { CheckCircle2, ChevronUp, CircleX, Cpu, LoaderCircle, TerminalSquare } from 'lucide-react'
import type { CpuProcessMetric, ProcessMetric, Snapshot } from '../types/models'
import { formatGpuProcessMemory } from '../utils/gpu'
import { cpuProcessRelation, gpuProcessRelation, processTaskRootPid } from '../utils/processRelations'

type ProcessSelection = { kind: 'gpu'; pid: number; gpuUuid: string } | { kind: 'cpu'; pid: number } | null
export type ProcessTerminationTarget = { kind: 'gpu' | 'cpu'; process: ProcessMetric | CpuProcessMetric }

function formatMemory(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 ** 2
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
}

function canTerminate(process: ProcessMetric | CpuProcessMetric) {
  return process.isCurrentUser
}

function sameSelection(left: ProcessSelection, right: Exclude<ProcessSelection, null>) {
  if (!left || left.kind !== right.kind || left.pid !== right.pid) return false
  return left.kind === 'cpu' || left.gpuUuid === (right as Extract<ProcessSelection, { kind: 'gpu' }>).gpuUuid
}

function toggleSelection(current: ProcessSelection, next: Exclude<ProcessSelection, null>): ProcessSelection {
  return sameSelection(current, next) ? null : next
}

function ProcessHeader({ kind, count, terminatingPid }: { kind: 'gpu' | 'cpu'; count: number; terminatingPid?: number }) {
  return <header className="panel__header process-block__header"><div><span>{kind === 'gpu' ? <TerminalSquare /> : <Cpu />}</span><div><h3>{kind === 'gpu' ? 'GPU 进程' : 'CPU 进程'}</h3><p>{kind === 'gpu' ? `${count} 个计算进程 · 按任务颜色分组` : `${count} 个非系统进程 · 内存大于 1 GB`}</p></div></div>{terminatingPid !== undefined && <span className="process-block__terminating" role="status" aria-live="polite"><LoaderCircle className="spin" size={15} />正在结束 PID {terminatingPid}</span>}</header>
}

function EmptyProcessBlock({ kind }: { kind: 'gpu' | 'cpu' }) {
  return <div className="inline-empty process-block__empty"><CheckCircle2 size={22} /><strong>当前没有{kind === 'gpu' ? ' GPU 计算' : '可显示的 CPU'}进程</strong></div>
}

function ProcessInlineDetails({ process, kind, snapshot, onClose, animate }: { process: ProcessMetric | CpuProcessMetric; kind: 'gpu' | 'cpu'; snapshot: Snapshot; onClose: () => void; animate: boolean }) {
  const relation = kind === 'gpu' ? gpuProcessRelation(process as ProcessMetric, snapshot) : cpuProcessRelation(process as CpuProcessMetric, snapshot)
  return <div className={`process-inline-inspector ${animate ? '' : 'process-inline-inspector--instant'}`} aria-label={`进程 ${process.pid} 详情`}><header><div><strong>进程详情</strong><span>{kind.toUpperCase()} · PID {process.pid} · {relation}</span></div><button type="button" className="process-inspector__collapse" aria-label="收起进程详情" onClick={onClose}><ChevronUp size={14} /><span>收起</span></button></header><dl className="process-inspector__facts"><div><dt>父进程</dt><dd className="mono">PID {process.parentPid || '—'}</dd></div><div><dt>用户</dt><dd>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</dd></div>{kind === 'gpu' ? <><div><dt>GPU</dt><dd>GPU {(process as ProcessMetric).gpuIndex}</dd></div><div><dt>GPU 显存</dt><dd>{formatGpuProcessMemory((process as ProcessMetric).memoryUsedMb)}</dd></div><div><dt>SM 活跃率</dt><dd>{((process as ProcessMetric).smUtilization ?? 0).toFixed(0)}%</dd></div></> : <><div><dt>CPU</dt><dd>{process.cpuPercent.toFixed(1)}%</dd></div><div><dt>系统内存</dt><dd>{(process as CpuProcessMetric).memoryPercent.toFixed(1)}% · {formatMemory((process as CpuProcessMetric).memoryUsedBytes)}</dd></div></>}<div><dt>运行时间</dt><dd>{process.elapsed}</dd></div></dl><div className="process-inspector__command"><span>命令</span><code>{process.command}</code></div></div>
}

function TerminateCell({ process, terminating, onTerminate }: { process: ProcessMetric | CpuProcessMetric; terminating: boolean; onTerminate?: () => void }) {
  const label = terminating ? `正在结束 PID ${process.pid}` : `结束 PID ${process.pid}`
  return <td className="process-select-cell" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>{canTerminate(process) && onTerminate ? <button type="button" className={`process-terminate-button ${terminating ? 'is-terminating' : ''}`} title={label} aria-label={label} disabled={terminating} onClick={onTerminate}>{terminating ? <LoaderCircle className="spin" size={13} /> : <CircleX size={12} strokeWidth={2.1} />}</button> : <span aria-hidden="true" />}</td>
}

function ProcessPid({ process, snapshot }: { process: ProcessMetric | CpuProcessMetric; snapshot: Snapshot }) {
  const taskRootPid = processTaskRootPid(process, snapshot)
  return <span className="process-pid" aria-label={`PID ${process.pid}，任务根 PID ${taskRootPid}`}><i className={`process-task-marker process-task-marker--${taskRootPid % 5}`} title={`任务根 PID ${taskRootPid}`} aria-hidden="true" /><span className="mono">{process.pid}</span></span>
}

function ProcessColGroup({ kind, compact }: { kind: 'gpu' | 'cpu'; compact: boolean }) {
  return <colgroup><col className="process-col--select" />{kind === 'gpu' && <col className="process-col--gpu" />}<col className="process-col--pid" /><col className="process-col--user" /><col className="process-col--command" /><col className={kind === 'gpu' ? 'process-col--gpu-memory' : 'process-col--cpu'} />{!compact && <><col className={kind === 'gpu' ? 'process-col--cpu' : 'process-col--system-memory'} /><col className="process-col--elapsed" /></>}</colgroup>
}

function GpuProcessRows({ processes, snapshot, selection, animateSelection, terminatingPid, onSelect, onRequestTerminate, compact }: { processes: ProcessMetric[]; snapshot: Snapshot; selection: ProcessSelection; animateSelection: boolean; terminatingPid?: number; onSelect: (selection: ProcessSelection, animate: boolean) => void; onRequestTerminate?: (target: ProcessTerminationTarget) => void; compact: boolean }) {
  return <tbody>{processes.map((process) => {
    const nextSelection = { kind: 'gpu' as const, pid: process.pid, gpuUuid: process.gpuUuid }
    const selected = sameSelection(selection, nextSelection)
    return <Fragment key={`${process.gpuUuid}-${process.pid}`}><tr tabIndex={0} aria-selected={selected} className={`${process.isCurrentUser ? 'is-current-user' : ''} ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(toggleSelection(selection, nextSelection), true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(toggleSelection(selection, nextSelection), false) } }}><TerminateCell process={process} terminating={terminatingPid === process.pid} onTerminate={onRequestTerminate ? () => onRequestTerminate({ kind: 'gpu', process }) : undefined} /><td>GPU {process.gpuIndex}</td><td><ProcessPid process={process} snapshot={snapshot} /></td><td>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</td><td className="process-command" title={process.command}>{process.command}</td><td>{formatGpuProcessMemory(process.memoryUsedMb)}</td>{!compact && <><td>{process.cpuPercent.toFixed(1)}%</td><td>{process.elapsed}</td></>}</tr>{selected && <tr className="process-detail-row"><td colSpan={compact ? 6 : 8}><ProcessInlineDetails process={process} kind="gpu" snapshot={snapshot} animate={animateSelection} onClose={() => onSelect(null, false)} /></td></tr>}</Fragment>
  })}</tbody>
}

function CpuProcessRows({ processes, snapshot, selection, animateSelection, terminatingPid, onSelect, onRequestTerminate, compact }: { processes: CpuProcessMetric[]; snapshot: Snapshot; selection: ProcessSelection; animateSelection: boolean; terminatingPid?: number; onSelect: (selection: ProcessSelection, animate: boolean) => void; onRequestTerminate?: (target: ProcessTerminationTarget) => void; compact: boolean }) {
  return <tbody>{processes.map((process) => {
    const nextSelection = { kind: 'cpu' as const, pid: process.pid }
    const selected = sameSelection(selection, nextSelection)
    return <Fragment key={process.pid}><tr tabIndex={0} aria-selected={selected} className={`${process.isCurrentUser ? 'is-current-user' : ''} ${selected ? 'is-selected' : ''}`} onClick={() => onSelect(toggleSelection(selection, nextSelection), true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(toggleSelection(selection, nextSelection), false) } }}><TerminateCell process={process} terminating={terminatingPid === process.pid} onTerminate={onRequestTerminate ? () => onRequestTerminate({ kind: 'cpu', process }) : undefined} /><td><ProcessPid process={process} snapshot={snapshot} /></td><td>{process.isCurrentUser && <span className="own-label">你</span>}{process.username}</td><td className="process-command" title={process.command}>{process.command}</td><td>{process.cpuPercent.toFixed(1)}%</td>{!compact && <><td>{process.memoryPercent.toFixed(1)}% · {formatMemory(process.memoryUsedBytes)}</td><td>{process.elapsed}</td></>}</tr>{selected && <tr className="process-detail-row"><td colSpan={compact ? 5 : 7}><ProcessInlineDetails process={process} kind="cpu" snapshot={snapshot} animate={animateSelection} onClose={() => onSelect(null, false)} /></td></tr>}</Fragment>
  })}</tbody>
}

export const ProcessBlocks = memo(function ProcessBlocks({ snapshot, compact = false, hideEmptyBlocks = false, terminatingPid, onRequestTerminate }: { snapshot: Snapshot; compact?: boolean; hideEmptyBlocks?: boolean; terminatingPid?: number; onRequestTerminate?: (target: ProcessTerminationTarget) => void }) {
  const [selection, setSelection] = useState<ProcessSelection>(null)
  const [animateSelection, setAnimateSelection] = useState(true)
  useEffect(() => {
    if (selection) {
      const exists = selection.kind === 'gpu' ? snapshot.processes.some((process) => process.pid === selection.pid && process.gpuUuid === selection.gpuUuid) : snapshot.cpuProcesses.some((process) => process.pid === selection.pid)
      if (!exists) setSelection(null)
    }
  }, [selection, snapshot.cpuProcesses, snapshot.processes])
  const gpuProcesses = compact ? snapshot.processes.slice(0, 5) : snapshot.processes
  const cpuProcesses = compact ? snapshot.cpuProcesses.slice(0, 5) : snapshot.cpuProcesses
  const terminatingGpuPid = terminatingPid !== undefined && snapshot.processes.some((process) => process.pid === terminatingPid) ? terminatingPid : undefined
  const terminatingCpuPid = terminatingPid !== undefined && snapshot.cpuProcesses.some((process) => process.pid === terminatingPid) ? terminatingPid : undefined
  const selectProcess = (next: ProcessSelection, animate: boolean) => { setAnimateSelection(animate); setSelection(next) }

  return <div className={`process-blocks ${compact ? 'process-blocks--compact' : ''}`}>
    {(!hideEmptyBlocks || snapshot.processes.length > 0) && <section className="panel process-panel"><ProcessHeader kind="gpu" count={snapshot.processes.length} terminatingPid={terminatingGpuPid} />{gpuProcesses.length ? <div className="table-scroll"><table className="process-table process-table--gpu"><ProcessColGroup kind="gpu" compact={compact} /><thead><tr><th aria-label="操作" /><th>GPU</th><th>PID</th><th>用户</th><th>命令</th><th>显存</th>{!compact && <><th>CPU</th><th>运行时间</th></>}</tr></thead><GpuProcessRows processes={gpuProcesses} snapshot={snapshot} selection={selection} animateSelection={animateSelection} terminatingPid={terminatingPid} onSelect={selectProcess} onRequestTerminate={onRequestTerminate} compact={compact} /></table></div> : <EmptyProcessBlock kind="gpu" />}{compact && snapshot.processes.length > gpuProcesses.length && <p className="process-block__more">另有 {snapshot.processes.length - gpuProcesses.length} 个 GPU 进程，请在“进程”页查看</p>}</section>}
    {(!hideEmptyBlocks || snapshot.cpuProcesses.length > 0) && <section className="panel process-panel"><ProcessHeader kind="cpu" count={snapshot.cpuProcesses.length} terminatingPid={terminatingCpuPid} />{cpuProcesses.length ? <div className="table-scroll"><table className="process-table process-table--cpu"><ProcessColGroup kind="cpu" compact={compact} /><thead><tr><th aria-label="操作" /><th>PID</th><th>用户</th><th>命令</th><th>CPU</th>{!compact && <><th>系统内存</th><th>运行时间</th></>}</tr></thead><CpuProcessRows processes={cpuProcesses} snapshot={snapshot} selection={selection} animateSelection={animateSelection} terminatingPid={terminatingPid} onSelect={selectProcess} onRequestTerminate={onRequestTerminate} compact={compact} /></table></div> : <EmptyProcessBlock kind="cpu" />}{compact && snapshot.cpuProcesses.length > cpuProcesses.length && <p className="process-block__more">另有 {snapshot.cpuProcesses.length - cpuProcesses.length} 个 CPU 进程，请在“进程”页查看</p>}</section>}
  </div>
}, (previous, next) => previous.snapshot === next.snapshot
  && previous.compact === next.compact
  && previous.hideEmptyBlocks === next.hideEmptyBlocks
  && previous.terminatingPid === next.terminatingPid)
