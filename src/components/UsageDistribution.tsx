import { Clock3, Database, MemoryStick } from 'lucide-react'
import type { Snapshot, UsageDistribution as UsageDistributionData } from '../types/models'
import { acceleratorLabel } from '../utils/accelerator'

const colors = ['#4f8ee8', '#5aa779', '#d08b42', '#a06bc4', '#cf6268', '#36a0a0', '#8e8650', '#7b8496']

interface Slice { name: string; percent: number; displayPercent: number; color: string; neutral?: boolean }

function slices(values: Array<{ name: string; value: number }>, coveredTotal: number, requestedTotal: number): Slice[] {
  if (requestedTotal <= 0) return [{ name: '缺失', percent: 100, displayPercent: 100, color: 'color-mix(in srgb, var(--text-tertiary) 24%, var(--surface))', neutral: true }]
  const boundedCoveredTotal = Math.min(requestedTotal, Math.max(0, coveredTotal))
  const users = values.filter((item) => item.value > 0).sort((a, b) => b.value - a.value).map((item, index) => ({
    name: item.name,
    percent: Math.max(0, item.value / requestedTotal * 100),
    displayPercent: boundedCoveredTotal > 0 ? Math.max(0, item.value / boundedCoveredTotal * 100) : 0,
    color: colors[index % colors.length],
  }))
  const usedValue = values.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  const unusedValue = Math.max(0, boundedCoveredTotal - usedValue)
  const unusedPercent = unusedValue / requestedTotal * 100
  const missingPercent = Math.max(0, requestedTotal - boundedCoveredTotal) / requestedTotal * 100
  return [
    ...users,
    { name: '未使用', percent: unusedPercent, displayPercent: boundedCoveredTotal > 0 ? unusedValue / boundedCoveredTotal * 100 : 0, color: 'var(--surface-muted)', neutral: true },
    { name: '缺失', percent: missingPercent, displayPercent: missingPercent, color: 'color-mix(in srgb, var(--text-tertiary) 24%, var(--surface))', neutral: true },
  ].filter((slice) => slice.percent > 0)
}

function displayColor(slice: Slice, strength: number) {
  return slice.neutral ? slice.color : `color-mix(in srgb, ${slice.color} ${strength}%, var(--surface))`
}

function Waffle({ title, subtitle, icon, data }: { title: string; subtitle: string; icon: React.ReactNode; data: Slice[] }) {
  const cellPercent = 100 / 190
  const cells = Array.from({ length: 190 }, (_, index) => {
    const midpoint = (index + 0.5) / 1.9
    let cursor = 0
    return { slice: data.find((slice) => { cursor += slice.percent; return midpoint <= cursor }) ?? data[data.length - 1], partial: false }
  })
  let cumulativePercent = 0
  for (const slice of data) {
    const intendedIndex = Math.min(cells.length - 1, Math.floor(cumulativePercent / cellPercent))
    cumulativePercent += slice.percent
    if (slice.neutral || slice.percent <= 0 || cells.some((cell) => cell.slice === slice)) continue
    const replacementIndex = cells.findIndex((cell, index) => index >= intendedIndex && cell.slice.neutral)
    const fallbackIndex = cells.findIndex((cell) => cell.slice.neutral)
    const index = replacementIndex >= 0 ? replacementIndex : fallbackIndex
    if (index >= 0) cells[index] = { slice, partial: slice.percent < cellPercent / 2 }
  }
  return <section className="panel usage-waffle"><header><span>{icon}</span><div><h3>{title}</h3><p>{subtitle}</p></div></header><div className="usage-waffle__grid" data-columns="38" data-rows="5" role="img" aria-label={`${title}百分比分布`}>{cells.map(({ slice, partial }, index) => <span key={index} data-partial={partial || undefined} style={{ background: displayColor(slice, partial ? 46 : 92) }} title={`${slice.name} ${slice.displayPercent.toFixed(1)}%`} />)}</div><div className="usage-waffle__legend">{data.map((slice) => <div key={slice.name}><i style={{ background: displayColor(slice, 92) }} /><span>{slice.name}</span><strong>{slice.displayPercent.toFixed(1)}%</strong></div>)}</div></section>
}

export function UsageDistribution({ snapshot, data }: { snapshot: Snapshot; data: UsageDistributionData }) {
  const accelerator = acceleratorLabel(snapshot)
  const averageGpuMemoryMb = snapshot.gpus.length ? snapshot.gpus.reduce((sum, gpu) => sum + gpu.memoryTotalMb, 0) / snapshot.gpus.length : 0
  if (!snapshot.gpus.length) return <div className="usage-empty"><Database size={24} /><strong>当前服务器没有可用 {accelerator}</strong></div>
  const requestedGpuSeconds = data.requestedDays * 86_400 * snapshot.gpus.length
  const coveredMemoryCapacity = data.coverageGpuSeconds * averageGpuMemoryMb
  const requestedMemoryCapacity = requestedGpuSeconds * averageGpuMemoryMb
  const active = slices(data.users.map((user) => ({ name: user.username, value: user.activeSeconds })), data.coverageGpuSeconds, requestedGpuSeconds)
  const memory = slices(data.users.map((user) => ({ name: user.username, value: user.memoryMbSeconds })), coveredMemoryCapacity, requestedMemoryCapacity)
  const coveredLabel = `按已覆盖 ${Math.min(data.coveredDays, data.requestedDays)} 天统计`
  return <div className="usage-waffle-list"><Waffle title="使用时间" subtitle={`用户活跃时间 · ${coveredLabel}`} icon={<Clock3 />} data={active} /><Waffle title="显存占用" subtitle={`显存积分 · ${coveredLabel}`} icon={<MemoryStick />} data={memory} /></div>
}
