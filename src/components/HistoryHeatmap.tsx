import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { DiskMetric, HistoryHeatmapPoint, Snapshot } from '../types/models'
import { buildHeatmapDays, HEATMAP_BUCKET_HOURS, HEATMAP_LABEL_STEP_DAYS, HEATMAP_ROWS_PER_DAY, heatmapLevel, historyHeatmapValue, indexHeatmapPoints } from '../utils/historyHeatmap'

type HeatmapMetric = 'utilization' | 'memory'
type HeatmapTone = 'blue' | 'green' | 'purple'

export function historyHeatmapTone(metric: HeatmapMetric, memoryTone: Exclude<HeatmapTone, 'purple'>): HeatmapTone {
  return metric === 'memory' ? memoryTone : 'purple'
}

interface ResourceHeatmapProps {
  title: string
  subtitle: string
  resource: 'cpu' | string
  points: HistoryHeatmapPoint[]
  days: ReturnType<typeof buildHeatmapDays>
  defaultMetric: HeatmapMetric
  memoryTone: Exclude<HeatmapTone, 'purple'>
  icon: ReactNode
}

function ResourceHeatmap({ title, subtitle, resource, points, days, defaultMetric, memoryTone, icon }: ResourceHeatmapProps) {
  const [metric, setMetric] = useState<HeatmapMetric>(defaultMetric)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pointIndex = useMemo(() => indexHeatmapPoints(points), [points])
  const metricLabel = metric === 'memory' ? 'MEM' : 'UTL'

  useEffect(() => {
    const element = scrollRef.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [days.length])

  return (
    <section className={`panel history-heatmap history-heatmap--${historyHeatmapTone(metric, memoryTone)}`}>
      <header className="history-heatmap__header">
        <div className="history-heatmap__identity"><span>{icon}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div>
        <div className="segmented-control" role="group" aria-label={`${title} 历史指标`}>
          <button type="button" aria-pressed={metric === 'utilization'} onClick={() => setMetric('utilization')}>UTL</button>
          <button type="button" aria-pressed={metric === 'memory'} onClick={() => setMetric('memory')}>MEM</button>
        </div>
      </header>
      <div className="history-heatmap__scroll" ref={scrollRef}>
        <div className="history-heatmap__grid" data-columns={days.length} data-rows={HEATMAP_ROWS_PER_DAY} style={{ gridTemplateColumns: `32px repeat(${days.length}, minmax(var(--heat-cell-size), 1fr))`, minWidth: `${32 + days.length * 13}px` }} role="img" aria-label={`${title} ${metricLabel} 每 3 小时平均值热力图`}>
          <span aria-hidden="true" />
          {days.map((day, index) => {
            const isEndLabel = index === days.length - 1
            const isStepLabel = index % HEATMAP_LABEL_STEP_DAYS === 0 && days.length - index > 3
            return <span className="history-heatmap__day" key={day.key} title={day.fullLabel}>{isStepLabel || isEndLabel ? day.label : ''}</span>
          })}
          {Array.from({ length: HEATMAP_ROWS_PER_DAY }, (_, row) => {
            const startHour = row * HEATMAP_BUCKET_HOURS
            const endHour = startHour + HEATMAP_BUCKET_HOURS
            return [
              <span className="history-heatmap__time" key={`time-${row}`}>{String(startHour).padStart(2, '0')}</span>,
              ...days.map((day) => {
                const point = pointIndex.get(`${day.key}:${row}`)
                const value = point ? historyHeatmapValue(point, resource, metric) : null
                const titleText = value === null
                  ? `${day.fullLabel} ${String(startHour).padStart(2, '0')}:00–${String(endHour).padStart(2, '0')}:00 · 无样本`
                  : `${day.fullLabel} ${String(startHour).padStart(2, '0')}:00–${String(endHour).padStart(2, '0')}:00 · ${metricLabel} 平均 ${value.toFixed(1)}% · ${point?.sampleCount ?? 0} 个样本`
                return <span className={`history-heatmap__cell ${value === null ? 'is-empty' : `is-level-${heatmapLevel(value)}`}`} key={`${day.key}:${row}`} title={titleText} aria-hidden="true" />
              }),
            ]
          })}
        </div>
      </div>
      <footer className="history-heatmap__legend"><span>低</span>{Array.from({ length: 6 }, (_, level) => <i className={`is-level-${level}`} key={level} />)}<span>高</span><small>每格 3 小时平均</small></footer>
    </section>
  )
}

export function HistoryHeatmaps({ snapshot, points, retentionDays }: { snapshot: Snapshot; points: HistoryHeatmapPoint[]; retentionDays: number }) {
  const days = useMemo(() => buildHeatmapDays(snapshot.timestamp, retentionDays), [retentionDays, snapshot.timestamp])
  return (
    <div className="history-heatmap-list">
      <ResourceHeatmap title="CPU" subtitle={snapshot.system.cpuModel || '系统 CPU'} resource="cpu" points={points} days={days} defaultMetric="memory" memoryTone="blue" icon={<Cpu size={16} />} />
      {snapshot.gpus.map((gpu) => <ResourceHeatmap key={gpu.uuid} title={`GPU ${gpu.index}`} subtitle={gpu.name.replace('NVIDIA ', '')} resource={gpu.uuid} points={points} days={days} defaultMetric="memory" memoryTone="green" icon={<MemoryStick size={16} />} />)}
    </div>
  )
}

function formatStorage(bytes: number) {
  const gb = bytes / 1024 ** 3
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`
}

export function StorageWaffleList({ disks }: { disks: DiskMetric[] }) {
  return (
    <section className="panel storage-waffle-panel">
      {disks.length === 0 ? <p className="storage-waffle__empty">暂无磁盘采样</p> : (
        <div className="storage-waffle-list">
          {disks.map((disk) => {
            const usedPercent = disk.totalBytes > 0 ? Math.min(100, disk.usedBytes / disk.totalBytes * 100) : 0
            const ownBytes = Math.min(disk.usedBytes, Math.max(0, disk.currentUserUsedBytes ?? 0))
            const otherBytes = Math.max(0, disk.usedBytes - ownBytes)
            const usedCells = Math.round(usedPercent * 5)
            const ownCells = disk.totalBytes > 0 ? Math.min(usedCells, Math.round(ownBytes / disk.totalBytes * 500)) : 0
            const otherCells = Math.max(0, usedCells - ownCells)
            return (
              <div className="storage-waffle-row" key={disk.mountPoint}>
                <strong className="storage-waffle-row__mount mono">{disk.mountPoint}</strong>
                <div className="storage-waffle-grid" data-columns="100" data-rows="5" role="img" aria-label={`${disk.mountPoint} 你占用 ${formatStorage(ownBytes)}，其他占用 ${formatStorage(otherBytes)}，共 ${formatStorage(disk.totalBytes)}`}>
                  {Array.from({ length: 500 }, (_, index) => <i className={index < ownCells ? 'is-own' : index < ownCells + otherCells ? 'is-other' : ''} data-storage-cell key={index} />)}
                </div>
                <div className="storage-waffle-row__footer">
                  <span><i className="is-own" />你的 <strong>{formatStorage(ownBytes)}</strong></span>
                  <span><i className="is-other" />其他 <strong>{formatStorage(otherBytes)}</strong></span>
                  <span>总计 <strong>{formatStorage(disk.totalBytes)}</strong> · {usedPercent.toFixed(1)}%</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
