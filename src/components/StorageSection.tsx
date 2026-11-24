import { useEffect, useRef, useState } from 'react'
import { HardDrive, LoaderCircle, RefreshCw } from 'lucide-react'
import { api } from '../services/api'
import type { DiskMetric, DiskScanState, MountScanStatus } from '../types/models'
import { StorageWaffleList } from './HistoryHeatmap'

const reasons: Partial<Record<MountScanStatus, string>> = {
  timeout: '统计超时', permissionDenied: '权限不足', connectionFailed: '连接失败',
  unrecognized: '未识别用户目录', duplicate: '用户目录重复，已跳过', failed: '统计失败', busy: '服务器仍有扫描未结束',
}
const AUTO_SCAN_DATES_KEY = 'racktop.storageAutoScanDates.v1'

function localDayKey(nowMs: number) {
  const date = new Date(nowMs)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

function wasAutoScanStartedToday(serverId: string, nowMs = Date.now()) {
  try {
    const dates = JSON.parse(localStorage.getItem(AUTO_SCAN_DATES_KEY) ?? '{}')
    return dates?.[serverId] === localDayKey(nowMs)
  } catch { return false }
}

function markAutoScanStartedToday(serverId: string, nowMs = Date.now()) {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTO_SCAN_DATES_KEY) ?? '{}')
    const dates = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    localStorage.setItem(AUTO_SCAN_DATES_KEY, JSON.stringify({ ...dates, [serverId]: localDayKey(nowMs) }))
  } catch { /* The persisted backend attempt timestamp remains the fallback gate. */ }
}

export function wasDiskScanAttemptedToday(lastAttemptAt: number, nowMs = Date.now()) {
  if (lastAttemptAt <= 0) return false
  const attemptedAt = new Date(lastAttemptAt * 1000)
  const now = new Date(nowMs)
  return attemptedAt.getFullYear() === now.getFullYear()
    && attemptedAt.getMonth() === now.getMonth()
    && attemptedAt.getDate() === now.getDate()
}

export function StorageSection({ serverId, disks }: { serverId: string; disks: DiskMetric[] }) {
  const [state, setState] = useState<DiskScanState | null>(null)
  const [error, setError] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const [capacity, setCapacity] = useState<DiskMetric[] | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const mountsKey = JSON.stringify(disks.map((disk) => disk.mountPoint))
  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let timer: number
    let autoRefreshAttempted = false
    const poll = async () => {
      let active = false
      if (!inFlight.current) {
        inFlight.current = true
        try {
          const stored = await api.getDiskScan(serverId)
          if (cancelled) return
          if (stored) setState(stored)
          let next = stored
          const automaticRefreshDue = !autoRefreshAttempted
            && !wasAutoScanStartedToday(serverId)
            && !wasDiskScanAttemptedToday(stored?.lastAttemptAt ?? 0)
          if (!stored?.running && !stored?.queued && automaticRefreshDue) {
            autoRefreshAttempted = true
            markAutoScanStartedToday(serverId)
            setRequesting(true)
            let mounts: string[] = JSON.parse(mountsKey)
            try {
              const snapshot = await api.collectServer(serverId, false, true, false)
              if (cancelled) return
              setCapacity(snapshot.disks ?? null)
              mounts = snapshot.disks?.map((disk) => disk.mountPoint) ?? mounts
            } catch { /* The ownership scan records connection failures separately. */ }
            next = await api.collectDiskUsage(serverId, mounts, true)
          }
          if (cancelled) return
          if (next) setState(next)
          setError('')
          active = Boolean(next?.running || next?.queued)
        } catch {
          if (!cancelled) setError('统计状态读取失败')
        } finally {
          inFlight.current = false
          if (!cancelled) setRequesting(false)
        }
      }
      if (!cancelled) timer = window.setTimeout(poll, active || inFlight.current ? 2000 : 30_000)
    }
    void poll()
    return () => { cancelled = true; mounted.current = false; window.clearTimeout(timer) }
  }, [serverId, mountsKey, refreshRevision])

  const busy = requesting || state?.running || state?.queued
  const refresh = async () => {
    if (busy || inFlight.current) return
    inFlight.current = true
    setRequesting(true)
    try {
      // Refresh fast capacity first; a previous successful pair still wins below.
      let mounts: string[] = JSON.parse(mountsKey)
      try {
        const snapshot = await api.collectServer(serverId, false, true, false)
        if (mounted.current) setCapacity(snapshot.disks ?? null)
        mounts = snapshot.disks?.map((disk) => disk.mountPoint) ?? mounts
      } catch { /* The scan records its own connection failure and cooldown. */ }
      const next = await api.collectDiskUsage(serverId, mounts, true)
      if (mounted.current) { setState(next); setError(''); setRefreshRevision((value) => value + 1) }
    } catch { if (mounted.current) setError('无法启动统计，请重试') }
    finally { inFlight.current = false; if (mounted.current) setRequesting(false) }
  }
  const entries = state?.mounts ?? []
  const sourceDisks = capacity ?? disks
  const missing = entries.filter((mount) => mount.result && !sourceDisks.some((disk) => disk.mountPoint === mount.mountPoint))
  const displayed = [...sourceDisks.map((disk) => entries.find((mount) => mount.mountPoint === disk.mountPoint)?.result ?? { ...disk, currentUserUsedBytes: null }), ...missing.map((mount) => mount.result!)]
  const timestamps = entries.flatMap((mount) => mount.collectedAt == null ? [] : [mount.collectedAt])
  const earliest = timestamps.length ? Math.min(...timestamps) : null
  const formatTime = (time: number) => new Date(time * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const failures = entries.filter((mount) => reasons[mount.status])
  const reason = error || [...new Set([...failures.map((mount) => reasons[mount.status]), ...(missing.length ? ['部分挂载点暂未采样'] : [])])].join(' · ')
  const detail = entries.map((mount) => `${mount.mountPoint}：${mount.collectedAt == null ? '暂无成功统计' : formatTime(mount.collectedAt)}${reasons[mount.status] ? `，${reasons[mount.status]}` : ''}`).join('\n')
  return <section className="history-section">
    <header className="history-page__header storage-section__header">
      <div><HardDrive size={18} /><span><h2>存储空间</h2><p>服务器磁盘占用情况，区分当前用户、其他用户与空闲空间</p></span></div>
      <div className="storage-scan-controls">
        <div className="storage-scan-meta" role="status" title={detail}>
          <small>{earliest == null ? '尚无分布统计' : `统计于 ${formatTime(earliest)}${new Set(timestamps).size > 1 ? ' 起' : ''}`}</small>
          <small className={reason ? 'storage-scan-reason' : ''}>{busy ? <><LoaderCircle size={11} className="spin" />{state?.queued ? '等待统计' : '正在更新'}{reason ? ` · ${reason}` : ''}</> : reason || (entries.length ? '已更新' : '等待磁盘采样')}</small>
        </div>
        <button className="icon-button" type="button" aria-label="刷新存储空间统计" title="刷新存储空间统计" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={14} /></button>
      </div>
    </header>
    <StorageWaffleList disks={displayed} />
  </section>
}
