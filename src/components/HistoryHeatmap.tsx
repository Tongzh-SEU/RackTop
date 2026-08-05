import { useMemo, useState, type ReactNode } from 'react'
import { Cpu, HardDrive, MemoryStick } from 'lucide-react'
import type { DiskMetric, HistoryHeatmapPoint, Snapshot } from '../types/models'
import { buildHeatmapDays, HEATMAP_BUCKET_HOURS, HEATMAP_ROWS_PER_DAY, heatmapLevel, historyHeatmapValue, indexHeatmapPoints } from '../utils/historyHeatmap'

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
  const pointIndex = useMemo(() => indexHeatmapPoints(points), [points])
  const labelStep = Math.max(1, Math.ceil(days.length / 8))
  const metricLabel = metric === 'memory' ? 'MEM' : 'UTL'

  return (
    <section className={`panel history-heatmap history-heatmap--${historyHeatmapTone(metric, memoryTone)}`}>
      <header className="history-heatmap__header">
        <div className="history-heatmap__identity"><span>{icon}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div>
        <div className="segmented-control" role="group" aria-label={`${title} 历史指标`}>
          <button type="button" aria-pressed={metric === 'utilization'} onClick={() => setMetric('utilization')}>UTL</button>
          <button type="button" aria-pressed={metric === 'memory'} onClick={() => setMetric('memory')}>MEM</button>
        </div>
      </header>
      <div className="history-heatmap__scroll">
        <div className="history-heatmap__grid" style={{ gridTemplateColumns: `42px repeat(${days.length}, var(--heat-cell-size))` }} role="img" aria-label={`${title} ${metricLabel} 每 3 小时平均值热力图`}>
          <span aria-hidden="true" />
          {days.map((day, index) => <span className="history-heatmap__day" key={day.key} title={day.fullLabel}>{index === 0 || index === days.length - 1 || (index % labelStep === 0 && days.length - index > 2) ? day.label : ''}</span>)}
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
  const disks = snapshot.disks ?? []
  return (
    <div className="history-view-stack">
      <div className="history-heatmap-list">
        <ResourceHeatmap title="CPU" subtitle={snapshot.system.cpuModel || '系统 CPU'} resource="cpu" points={points} days={days} defaultMetric="memory" memoryTone="blue" icon={<Cpu size={16} />} />
        {snapshot.gpus.map((gpu) => <ResourceHeatmap key={gpu.uuid} title={`GPU ${gpu.index}`} subtitle={gpu.name.replace('NVIDIA ', '')} resource={gpu.uuid} points={points} days={days} defaultMetric="memory" memoryTone="green" icon={<MemoryStick size={16} />} />)}
      </div>
      <StorageWaffleList disks={disks} />
    </div>
  )
}

function formatStorage(bytes: number) {
  const gb = bytes / 1024 ** 3
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`
}

function StorageWaffleList({ disks }: { disks: DiskMetric[] }) {
  return (
    <section className="panel storage-waffle-panel">
      <header className="history-heatmap__header">
        <div className="history-heatmap__identity">
          <span className="storage-waffle__icon"><HardDrive size={16} /></span>
          <div><h3>存储空间</h3><p>各挂载磁盘当前已用空间；每格代表 0.5%</p></div>
        </div>
      </header>
      {disks.length === 0 ? <p className="storage-waffle__empty">暂无磁盘采样</p> : (
        <div className="storage-waffle-list">
          {disks.map((disk) => {
            const usedPercent = disk.totalBytes > 0 ? Math.min(100, disk.usedBytes / disk.totalBytes * 100) : 0
            const filled = Math.round(usedPercent * 2)
            return (
              <div className="storage-waffle-row" key={disk.mountPoint}>
                <strong className="storage-waffle-row__mount mono">{disk.mountPoint}</strong>
                <div className="storage-waffle-grid" data-columns="50" data-rows="4" role="img" aria-label={`${disk.mountPoint} 已用 ${formatStorage(disk.usedBytes)}，共 ${formatStorage(disk.totalBytes)}`}>
                  {Array.from({ length: 200 }, (_, index) => <i className={index < filled ? 'is-used' : ''} data-storage-cell key={index} />)}
                </div>
                <div className="storage-waffle-row__footer">
                  <span><i className="is-used" />已用 <strong>{formatStorage(disk.usedBytes)}</strong></span>
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
