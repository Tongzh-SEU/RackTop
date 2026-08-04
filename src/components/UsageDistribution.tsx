import { Clock3, Database, MemoryStick } from 'lucide-react'
import type { Snapshot, UsageDistribution as UsageDistributionData } from '../types/models'

const colors = ['#4f8ee8', '#5aa779', '#d08b42', '#a06bc4', '#cf6268', '#36a0a0', '#8e8650', '#7b8496']

interface Slice { name: string; percent: number; color: string }

function slices(values: Array<{ name: string; value: number }>, total: number): Slice[] {
  if (total <= 0) return [{ name: '未使用', percent: 100, color: 'var(--surface-muted)' }]
  const users = values.filter((item) => item.value > 0).sort((a, b) => b.value - a.value).map((item, index) => ({ name: item.name, percent: Math.max(0, item.value / total * 100), color: colors[index % colors.length] }))
  const used = users.reduce((sum, item) => sum + item.percent, 0)
  return [...users, { name: '未使用', percent: Math.max(0, 100 - used), color: 'var(--surface-muted)' }]
}

function Waffle({ title, subtitle, icon, data }: { title: string; subtitle: string; icon: React.ReactNode; data: Slice[] }) {
  const cells = Array.from({ length: 100 }, (_, index) => {
    const midpoint = index + 0.5
    let cursor = 0
    return data.find((slice) => { cursor += slice.percent; return midpoint <= cursor }) ?? data[data.length - 1]
  })
  return <section className="panel usage-waffle"><header><span>{icon}</span><div><h3>{title}</h3><p>{subtitle}</p></div></header><div className="usage-waffle__grid" role="img" aria-label={`${title}百分比分布`}>{cells.map((slice, index) => <span key={index} style={{ background: slice.color }} title={`${slice.name} ${slice.percent.toFixed(1)}%`} />)}</div><div className="usage-waffle__legend">{data.map((slice) => <div key={slice.name}><i style={{ background: slice.color }} /><span>{slice.name}</span><strong>{slice.percent.toFixed(1)}%</strong></div>)}</div></section>
}

export function UsageDistribution({ snapshot, data }: { snapshot: Snapshot; data: UsageDistributionData }) {
  const averageGpuMemoryMb = snapshot.gpus.length ? snapshot.gpus.reduce((sum, gpu) => sum + gpu.memoryTotalMb, 0) / snapshot.gpus.length : 0
  const memoryCapacity = data.coverageGpuSeconds * averageGpuMemoryMb
  const active = slices(data.users.map((user) => ({ name: user.username, value: user.activeSeconds })), data.coverageGpuSeconds)
  const memory = slices(data.users.map((user) => ({ name: user.username, value: user.memoryMbSeconds })), memoryCapacity)
  if (!data.coverageGpuSeconds) return <div className="usage-empty"><Database size={24} /><strong>还没有使用分布数据</strong><p>{snapshot.gpus.length ? 'RackTop 在线采样约一分钟后会在这里显示；未启用远端保存时，App 离线期间保持为缺失。' : '当前服务器没有可用 GPU。'}</p></div>
  return <><div className="usage-coverage"><Database size={15} /><span>已覆盖 <strong>{data.coveredDays} / {data.requestedDays} 天</strong></span>{data.coveredDays < data.requestedDays && <small>缺失时段未按零使用补齐</small>}</div><div className="usage-waffle-list"><Waffle title="使用时间" subtitle="用户活跃时间 / GPU 数量 × 已覆盖时间" icon={<Clock3 />} data={active} /><Waffle title="显存占用" subtitle="显存积分 / 总显存 × 已覆盖时间" icon={<MemoryStick />} data={memory} /></div></>
}
