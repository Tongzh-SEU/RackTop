import { memo } from 'react'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { HistoryPoint, Snapshot } from '../types/models'
import { acceleratorLabel } from '../utils/accelerator'
import { clampPercent } from '../utils/gpu'
import { formatFiveMinuteTimeLabel, MINUTE_MS, minuteTickSplitNumber } from '../utils/timeAxis'

echarts.use([LineChart, GridComponent, LegendComponent, MarkAreaComponent, TooltipComponent, CanvasRenderer])

const BYTES_PER_GB = 1024 ** 3
const MAX_CONTINUOUS_GAP_MS = 5 * MINUTE_MS
const COMPACTED_CONTINUOUS_GAP_MS = 12 * MINUTE_MS

function continuousGapThreshold(points: HistoryPoint[]) {
  const intervals = points.slice(1).map((point, index) => (point.timestamp - points[index].timestamp) * 1000).filter((value) => value > 0).sort((a, b) => a - b)
  if (intervals.length < 3) return MAX_CONTINUOUS_GAP_MS
  const typical = intervals[Math.floor(intervals.length / 2)] ?? 0
  return Math.max(MAX_CONTINUOUS_GAP_MS, typical * 2.5)
}

interface GapThresholds {
  raw: number
  compacted: number
}

function gapThresholds(points: HistoryPoint[]): GapThresholds {
  const raw = continuousGapThreshold(points)
  return { raw, compacted: Math.max(raw, COMPACTED_CONTINUOUS_GAP_MS) }
}

function gapThreshold(previous: HistoryPoint | undefined, point: HistoryPoint | undefined, thresholds: GapThresholds) {
  return previous?.isCompacted || point?.isCompacted ? thresholds.compacted : thresholds.raw
}

export function trendSeriesData(points: HistoryPoint[], valueOf: (point: HistoryPoint) => number | null, thresholds = gapThresholds(points)) {
  const data: Array<[number, number | null]> = []
  points.forEach((point, index) => {
    const timestamp = point.timestamp * 1000
    const previous = points[index - 1]
    if (previous && timestamp - previous.timestamp * 1000 > gapThreshold(previous, point, thresholds)) {
      data.push([Math.floor((timestamp + previous.timestamp * 1000) / 2), null])
    }
    const value = valueOf(point)
    data.push([timestamp, value === null ? null : clampPercent(value)])
  })
  return data
}

export function missingTimeRanges(points: HistoryPoint[], thresholds = gapThresholds(points)) {
  const data: Array<[{ xAxis: number }, { xAxis: number }]> = []
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    if ((point.timestamp - previous.timestamp) * 1000 <= gapThreshold(previous, point, thresholds)) continue
    data.push([
      { xAxis: (previous.timestamp + 60) * 1000 },
      { xAxis: (point.timestamp - 60) * 1000 },
    ])
  }
  return data
}

function peakRangeSeries(id: string, points: HistoryPoint[], averageOf: (point: HistoryPoint) => number | null, minOf: (point: HistoryPoint) => number | null, maxOf: (point: HistoryPoint) => number | null, color: string, thresholds: GapThresholds) {
  const stack = `${id}:range`
  return [{ id: `${id}:range-min`, type: 'line', stack, silent: true, showSymbol: false, connectNulls: false, data: trendSeriesData(points, (point) => minOf(point) ?? averageOf(point), thresholds), lineStyle: { width: 0, opacity: 0 }, areaStyle: { opacity: 0 }, tooltip: { show: false } }, { id: `${id}:range-span`, type: 'line', stack, silent: true, showSymbol: false, connectNulls: false, data: trendSeriesData(points, (point) => { const average = averageOf(point); const min = minOf(point) ?? average; const max = maxOf(point) ?? average; return min == null || max == null ? null : Math.max(0, max - min) }, thresholds), lineStyle: { width: 0, opacity: 0 }, areaStyle: { color, opacity: 0.1 }, tooltip: { show: false } }]
}

function percentTooltip(value: number) {
  return `${Number(value).toFixed(1)}%`
}

function capacityTooltip(value: number, totalGb: number) {
  const percent = clampPercent(Number(value))
  const usedGb = totalGb * percent / 100
  return `${percent.toFixed(1)}% · ${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`
}

function timeAxisInterval(timestamps: number[]) {
  if (timestamps.length < 2) return 10 * MINUTE_MS
  const span = Math.max(0, timestamps[timestamps.length - 1] - timestamps[0])
  if (span <= 90 * MINUTE_MS) return 10 * MINUTE_MS
  if (span <= 6 * 60 * MINUTE_MS) return 30 * MINUTE_MS
  if (span <= 36 * 60 * MINUTE_MS) return 3 * 60 * MINUTE_MS
  return 12 * 60 * MINUTE_MS
}

interface TrendChartProps {
  points: HistoryPoint[]
  snapshot?: Snapshot
  mode?: 'all' | 'cpu' | 'gpu' | 'systemMemory' | 'gpuMemory'
  height?: number
  animate?: boolean
  gpuUuid?: string
  seriesOpacity?: number
}

function TrendChartComponent({ points, snapshot, mode = 'all', height = 260, animate = false, gpuUuid, seriesOpacity = 1 }: TrendChartProps) {
  const accelerator = snapshot ? acceleratorLabel(snapshot) : 'GPU'
  const series = []
  const opacity = Math.min(1, Math.max(0, seriesOpacity))
  const timestamps = points.map((point) => point.timestamp * 1000)
  const axisInterval = timeAxisInterval(timestamps)
  const thresholds = gapThresholds(points)
  const missingRanges = missingTimeRanges(points, thresholds)
  const missingArea = missingRanges.length ? { silent: true, label: { show: false }, itemStyle: { color: 'rgba(142, 145, 152, 0.08)' }, data: missingRanges } : undefined
  if (mode === 'all' || mode === 'cpu') {
    const valueOf = (point: HistoryPoint) => point.cpuUtilization
    series.push(...peakRangeSeries('cpu-utilization', points, valueOf, (point) => point.cpuMin ?? null, (point) => point.cpuMax ?? null, '#0a84ff', thresholds))
    series.push({
      id: 'cpu-utilization',
      name: 'CPU',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      connectNulls: false,
      data: trendSeriesData(points, valueOf, thresholds),
      tooltip: { valueFormatter: percentTooltip },
      lineStyle: { width: 2, color: '#0a84ff' },
      itemStyle: { color: '#0a84ff' },
      areaStyle: { color: 'rgba(10, 132, 255, 0.08)' },
      markArea: missingArea,
    })
  }
  if (mode === 'systemMemory') {
    const memoryValueOf = (point: HistoryPoint) => point.memoryUtilization
    series.push(...peakRangeSeries('system-memory-utilization', points, memoryValueOf, (point) => point.memoryMin ?? null, (point) => point.memoryMax ?? null, '#af52de', thresholds))
    series.push({
      id: 'system-memory-utilization',
      name: '系统内存',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      connectNulls: false,
      data: trendSeriesData(points, memoryValueOf, thresholds),
      tooltip: { valueFormatter: (value: number) => capacityTooltip(value, (snapshot?.system.memoryTotalBytes ?? 0) / BYTES_PER_GB) },
      lineStyle: { width: 2, color: '#af52de' },
      itemStyle: { color: '#af52de' },
      areaStyle: { color: 'rgba(175, 82, 222, 0.08)' },
      markArea: missingArea,
    })
    const swapValueOf = (point: HistoryPoint) => point.swapUtilization ?? null
    series.push(...peakRangeSeries('swap-utilization', points, swapValueOf, (point) => point.swapMin ?? null, (point) => point.swapMax ?? null, '#ff9f0a', thresholds))
    series.push({
      id: 'swap-utilization',
      name: 'SWP',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      connectNulls: false,
      data: trendSeriesData(points, swapValueOf, thresholds),
      tooltip: { valueFormatter: (value: number) => capacityTooltip(value, (snapshot?.system.swapTotalBytes ?? 0) / BYTES_PER_GB) },
      lineStyle: { width: 2, color: '#ff9f0a' },
      itemStyle: { color: '#ff9f0a' },
      areaStyle: { color: 'rgba(255, 159, 10, 0.05)' },
    })
  }
  if (mode === 'all' || mode === 'gpu' || mode === 'gpuMemory') {
    snapshot?.gpus.filter((gpu) => !gpuUuid || gpu.uuid === gpuUuid).forEach((gpu, index) => {
      const colors = ['#30d158', '#bf5af2', '#ff9f0a', '#64d2ff']
      const isMemory = mode === 'gpuMemory'
      const id = `${isMemory ? 'gpu-memory' : 'gpu-utilization'}:${gpu.uuid}`
      const color = colors[index % colors.length]
      const valueOf = (point: HistoryPoint) => isMemory ? point.gpuMemoryUtilizations?.[gpu.uuid] ?? null : point.gpuUtilizations[gpu.uuid] ?? null
      const minOf = (point: HistoryPoint) => isMemory ? point.gpuMemoryMins?.[gpu.uuid] ?? null : point.gpuMins?.[gpu.uuid] ?? null
      const maxOf = (point: HistoryPoint) => isMemory ? point.gpuMemoryMaxes?.[gpu.uuid] ?? null : point.gpuMaxes?.[gpu.uuid] ?? null
      series.push(...peakRangeSeries(id, points, valueOf, minOf, maxOf, color, thresholds))
      series.push({
        id,
        name: `${accelerator} ${gpu.index}`,
        type: 'line',
        showSymbol: false,
        smooth: false,
        clip: true,
        connectNulls: false,
        data: trendSeriesData(points, valueOf, thresholds),
        tooltip: { valueFormatter: isMemory ? (value: number) => capacityTooltip(value, gpu.memoryTotalMb / 1024) : percentTooltip },
        lineStyle: { width: 2, color, opacity },
        itemStyle: { color, opacity },
        markArea: index === 0 ? missingArea : undefined,
      })
    })
  }

  return (
    <ReactEChartsCore
      echarts={echarts}
      style={{ width: '100%', minWidth: 0, height }}
      option={{
        animation: animate,
        animationDuration: animate ? 180 : 0,
        animationDurationUpdate: animate ? 180 : 0,
        animationEasing: 'cubicOut',
        animationEasingUpdate: 'cubicOut',
        textStyle: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
        grid: { top: 36, right: 14, bottom: 28, left: 42 },
        legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 4, textStyle: { color: '#7b7f87', fontSize: 11 } },
        tooltip: { trigger: 'axis' },
        xAxis: {
          type: 'time',
          boundaryGap: false,
          splitNumber: minuteTickSplitNumber(timestamps),
          minInterval: axisInterval,
          maxInterval: axisInterval,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { formatter: formatFiveMinuteTimeLabel, color: '#8e9198', fontSize: 10 },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 100,
          axisLabel: { formatter: '{value}%', color: '#8e9198', fontSize: 10 },
          splitLine: { lineStyle: { color: 'rgba(127, 127, 127, 0.12)' } },
        },
        series,
      }}
      replaceMerge="series"
      opts={{ renderer: 'canvas' }}
    />
  )
}

function sameSnapshotShape(previous?: Snapshot, next?: Snapshot) {
  if (previous === next) return true
  if (!previous || !next) return false
  if (previous.system.memoryTotalBytes !== next.system.memoryTotalBytes || previous.system.swapTotalBytes !== next.system.swapTotalBytes) return false
  if (previous.gpus.length !== next.gpus.length) return false
  return previous.gpus.every((gpu, index) => {
    const other = next.gpus[index]
    return gpu.uuid === other?.uuid && gpu.index === other.index && gpu.memoryTotalMb === other.memoryTotalMb
  })
}

export const TrendChart = memo(TrendChartComponent, (previous, next) => (
  previous.points === next.points
  && previous.mode === next.mode
  && previous.height === next.height
  && previous.animate === next.animate
  && previous.gpuUuid === next.gpuUuid
  && previous.seriesOpacity === next.seriesOpacity
  && sameSnapshotShape(previous.snapshot, next.snapshot)
))
