import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../services/api'
import type { HistoryPoint, Snapshot } from '../types/models'
import { getCachedTrendHistory, loadCachedTrendHistory } from '../utils/trendHistoryCache'
import { TrendChart } from './TrendChart'

type Range = 1 | 3 | 24 | 72
type Metric = 'utl' | 'mem'

function coverageLabel(points: HistoryPoint[]) {
  if (points.length < 2) return '等待更多样本'
  const seconds = Math.max(0, points.at(-1)!.timestamp - points[0].timestamp)
  if (seconds < 3600) return `已覆盖 ${Math.max(1, Math.round(seconds / 60))} 分钟`
  return `已覆盖 ${(seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0)} 小时`
}

export function ResourceTrend({ snapshot, kind, gpuUuid, title, animate }: { snapshot: Snapshot; kind: 'gpu' | 'cpu'; gpuUuid?: string; title: string; animate: boolean }) {
  const [range, setRange] = useState<Range>(3)
  const [metric, setMetric] = useState<Metric>(kind === 'gpu' ? 'mem' : 'utl')
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const bucketSeconds = range > 3 ? 10 * 60 : undefined
    const cacheKey = `${snapshot.serverId}:${range}:${bucketSeconds ?? 0}`
    const cached = getCachedTrendHistory(cacheKey)
    setPoints(cached ?? [])
    setLoading(!cached)
    setError(null)
    const load = () => loadCachedTrendHistory(cacheKey, () => api.getHistory(snapshot.serverId, Math.floor(Date.now() / 1000) - range * 3600, bucketSeconds)).then((value) => { if (!cancelled) setPoints(value) }).catch((reason) => { if (!cancelled) setError(String(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    void load()
    const interval = window.setInterval(() => void load(), 30_000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [range, snapshot.serverId])
  const mode = kind === 'cpu' ? (metric === 'utl' ? 'cpu' : 'systemMemory') : (metric === 'utl' ? 'gpu' : 'gpuMemory')
  return <section className="panel panel--chart resource-trend"><header className="resource-trend__header"><div><strong>{title}</strong><small>{error ?? coverageLabel(points)}</small></div><div className="resource-trend__controls"><span>{([1, 3, 24, 72] as const).map((hours) => <button key={hours} aria-pressed={range === hours} onClick={() => setRange(hours)}>{hours === 1 ? '1h' : hours === 3 ? '3h' : hours === 24 ? '1d' : '3d'}</button>)}</span><span>{(['utl', 'mem'] as const).map((value) => <button key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{value.toUpperCase()}</button>)}</span></div></header>{loading && points.length === 0 ? <div className="resource-trend__loading"><RefreshCw className="spin" size={15} />正在读取…</div> : <TrendChart points={points} snapshot={snapshot} mode={mode} gpuUuid={gpuUuid} height={220} animate={animate} />}</section>
}
