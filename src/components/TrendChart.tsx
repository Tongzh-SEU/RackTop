import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { HistoryPoint, Snapshot } from '../types/models'
import { clampPercent, gpuMemoryPercent } from '../utils/gpu'
import { formatFiveMinuteTimeLabel, MINUTE_MS, minuteTickSplitNumber } from '../utils/timeAxis'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

const BYTES_PER_GB = 1024 ** 3
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
}

export function TrendChart({ points, snapshot, mode = 'all', height = 260, animate = false, gpuUuid }: TrendChartProps) {
  const series = []
  const timestamps = points.map((point) => point.timestamp * 1000)
  const axisInterval = timeAxisInterval(timestamps)
  if (mode === 'all' || mode === 'cpu') {
    series.push({
      id: 'cpu-utilization',
      name: 'CPU',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      data: points.map((point) => [point.timestamp * 1000, clampPercent(point.cpuUtilization)]),
      tooltip: { valueFormatter: percentTooltip },
      lineStyle: { width: 2, color: '#0a84ff' },
      itemStyle: { color: '#0a84ff' },
      areaStyle: { color: 'rgba(10, 132, 255, 0.08)' },
    })
  }
  if (mode === 'systemMemory') {
    series.push({
      id: 'system-memory-utilization',
      name: '系统内存',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      data: points.map((point) => [point.timestamp * 1000, clampPercent(point.memoryUtilization)]),
      tooltip: { valueFormatter: (value: number) => capacityTooltip(value, (snapshot?.system.memoryTotalBytes ?? 0) / BYTES_PER_GB) },
      lineStyle: { width: 2, color: '#af52de' },
      itemStyle: { color: '#af52de' },
      areaStyle: { color: 'rgba(175, 82, 222, 0.08)' },
    })
    series.push({
      id: 'swap-utilization',
      name: 'SWP',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      data: points.map((point) => [point.timestamp * 1000, clampPercent(point.swapUtilization ?? 0)]),
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
      series.push({
        id: `${isMemory ? 'gpu-memory' : 'gpu-utilization'}:${gpu.uuid}`,
        name: `GPU ${gpu.index}`,
        type: 'line',
        showSymbol: false,
        smooth: false,
        clip: true,
        data: points.map((point) => [point.timestamp * 1000, clampPercent(isMemory ? point.gpuMemoryUtilizations?.[gpu.uuid] ?? gpuMemoryPercent(gpu) : point.gpuUtilizations[gpu.uuid] ?? 0)]),
        tooltip: { valueFormatter: isMemory ? (value: number) => capacityTooltip(value, gpu.memoryTotalMb / 1024) : percentTooltip },
        lineStyle: { width: 2, color: colors[index % colors.length] },
        itemStyle: { color: colors[index % colors.length] },
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
