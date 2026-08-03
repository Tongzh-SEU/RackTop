import ReactEChartsCore from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { HistoryPoint, Snapshot } from '../types/models'
import { clampPercent } from '../utils/gpu'

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

interface TrendChartProps {
  points: HistoryPoint[]
  snapshot?: Snapshot
  mode?: 'all' | 'cpu' | 'gpu'
  height?: number
}

export function TrendChart({ points, snapshot, mode = 'all', height = 260 }: TrendChartProps) {
  const reducedMotion = document.documentElement.dataset.reduceMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const series = []
  if (mode !== 'gpu') {
    series.push({
      name: 'CPU',
      type: 'line',
      showSymbol: false,
      smooth: false,
      clip: true,
      data: points.map((point) => [point.timestamp * 1000, clampPercent(point.cpuUtilization)]),
      lineStyle: { width: 2, color: '#0a84ff' },
      itemStyle: { color: '#0a84ff' },
      areaStyle: { color: 'rgba(10, 132, 255, 0.08)' },
    })
  }
  if (mode !== 'cpu') {
    snapshot?.gpus.forEach((gpu, index) => {
      const colors = ['#30d158', '#bf5af2', '#ff9f0a', '#64d2ff']
      series.push({
        name: `GPU ${gpu.index}`,
        type: 'line',
        showSymbol: false,
        smooth: false,
        clip: true,
        data: points.map((point) => [point.timestamp * 1000, clampPercent(point.gpuUtilizations[gpu.uuid] ?? 0)]),
        lineStyle: { width: 2, color: colors[index % colors.length] },
        itemStyle: { color: colors[index % colors.length] },
      })
    })
  }

  return (
    <ReactEChartsCore
      echarts={echarts}
      style={{ height }}
      option={{
        animation: !reducedMotion,
        animationDuration: reducedMotion ? 0 : 180,
        animationEasing: 'cubicOut',
        textStyle: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
        grid: { top: 36, right: 14, bottom: 28, left: 42 },
        legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 4, textStyle: { color: '#7b7f87', fontSize: 11 } },
        tooltip: { trigger: 'axis', valueFormatter: (value: number) => `${Number(value).toFixed(1)}%` },
        xAxis: {
          type: 'time',
          boundaryGap: false,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#8e9198', fontSize: 10 },
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
      opts={{ renderer: 'canvas' }}
    />
  )
}
