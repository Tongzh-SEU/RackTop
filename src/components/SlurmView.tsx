import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import type { GpuMetric, Server, SlurmJob, SlurmOverview, Snapshot } from '../types/models'
import { api } from '../services/api'
import { clampPercent, displayedGpuMemoryPercent, gpuLoadLevel, gpuMemoryLevel, gpuMemoryPercent, isGpuAvailable } from '../utils/gpu'
import { slurmPartitionResources } from '../utils/slurm'
import './SlurmView.css'

const waitingReasons: Record<string, string> = { Dependency: '等待依赖作业', Priority: '调度优先级', Resources: '资源不足' }

export function SlurmView({ serverId, servers, snapshots }: { serverId: string; servers: Server[]; snapshots: Record<string, Snapshot> }) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ data?: SlurmOverview; error?: string; updatedAt?: Date; completedAttempt: number }>({ completedAttempt: -1 })
  const loading = state.completedAttempt !== attempt
  useEffect(() => {
    let active = true
    api.collectSlurm(serverId).then(
      (data) => { if (active) setState({ data, completedAttempt: attempt, updatedAt: new Date() }) },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (active) setState((previous) => ({ ...previous, error: message, completedAttempt: attempt }))
      },
    )
    return () => { active = false }
  }, [serverId, attempt])

  const { data, error, updatedAt } = state
  const now = Math.floor(Date.now() / 1000)
  return <div className="content-stack slurm-view">
    <header className="slurm-heading">
      <h2>Slurm 集群</h2>
      <div><span role="status">{loading ? '正在查询 Slurm…' : updatedAt ? `最近查询 ${updatedAt.toLocaleTimeString()}` : ''}</span>
        <button type="button" className="button button--secondary button--small" disabled={loading} onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新 Slurm</button>
      </div>
    </header>
    {!loading && error && <p role="alert" className="panel slurm-message">{data ? '刷新失败，显示上次查询。' : '无法读取 Slurm。'}{error}</p>}
    {data && <>
      <WaitingJobs overview={data} />
      <section aria-labelledby="slurm-partitions">
        <header className="slurm-heading"><h3 id="slurm-partitions">分区资源</h3><span>{data.partitions.length} 个分区 · 用量来自已接入 RackTop 的节点</span></header>
        {data.partitions.length === 0
          ? <p className="panel slurm-message">当前账号看不到任何 Slurm 分区。</p>
          : <div className="fleet-grid slurm-partitions">
            {data.partitions.map((partition) => <PartitionCard key={partition.name} name={partition.name} resource={slurmPartitionResources(data, partition, servers, snapshots, now)} />)}
          </div>}
      </section>
    </>}
  </div>
}

function WaitingJobs({ overview }: { overview: SlurmOverview }) {
  const groups = [
    { label: '我的等待作业', own: true, jobs: overview.jobs.filter((job) => job.user === overview.username) },
    { label: '其他用户的等待作业', own: false, jobs: overview.jobs.filter((job) => job.user !== overview.username) },
  ]
  return <section className="panel slurm-queue" aria-labelledby="slurm-waiting-jobs">
    <header className="slurm-heading"><h3 id="slurm-waiting-jobs">等待作业列表</h3><span>{overview.jobs.length} 个可见等待作业</span></header>
    <div className="slurm-table-scroll"><table aria-labelledby="slurm-waiting-jobs">
      <thead><tr>{['作业 ID', '名称', '用户', '分区', 'CPU', '等待原因'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
      {groups.map(({ label, own, jobs }) => <tbody key={label} className={own ? 'slurm-queue-own' : undefined}>
        <tr className="slurm-queue-group"><th scope="rowgroup" colSpan={6}>{label} <small>{jobs.length} 个</small></th></tr>
        {jobs.length ? jobs.map((job) => <JobRow key={`${job.id}:${job.partition}`} job={job} />) : <tr><td colSpan={6}>暂无可见作业</td></tr>}
      </tbody>)}
    </table></div>
  </section>
}

function JobRow({ job }: { job: SlurmJob }) {
  return <tr><td>{job.id}</td><td>{job.name}</td><td className="slurm-job-user">{job.user}</td><td>{job.partition}</td><td>{job.cpus}</td><td>{Object.hasOwn(waitingReasons, job.reason) ? waitingReasons[job.reason] : job.reason || '—'}</td></tr>
}

function PartitionCard({ name, resource }: { name: string; resource: ReturnType<typeof slurmPartitionResources> }) {
  const [expanded, setExpanded] = useState(false)
  const id = `slurm-nodes-${name}`
  const gpuNodes = resource.nodes.filter(({ node, sample }) => node?.gpuTypes.length || sample?.gpus.length)
  return <article className="panel fleet-card slurm-partition">
    <button type="button" className="fleet-card__header" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((value) => !value)}>
      <span aria-hidden="true" className={`slurm-sample-dot${resource.sampledNodes ? ' is-sampled' : ''}`} />
      <span><strong>{name}</strong><small>{resource.nodes.length} 个节点</small></span>
      <span className="slurm-sample-count">已采样 {resource.sampledNodes} / {resource.nodes.length}</span><ChevronRight size={15} aria-hidden="true" />
    </button>
    <CpuReading percent={resource.cpuPercent} allocated={resource.cpuAllocated} total={resource.cpuTotal} />
    <div className="fleet-gpus">
      {gpuNodes.length > 0 && <div className="fleet-gpus__labels"><span>设备</span><span>GPU MEM</span><span>GPU UTL</span></div>}
      {gpuNodes.map(({ name: nodeName, node, sample }) => {
        const gpus = sample?.gpus ?? []
        const inventory = node?.gpuTypes.flatMap(({ name: type, count }) => Array.from({ length: count }, () => type)) ?? []
        return <section className="slurm-device-group" key={nodeName} aria-label={`${nodeName} 的 GPU`}>
          <h4>{nodeName} <small>{node?.state}</small></h4>
          {gpus.map((gpu) => <GpuRow key={gpu.uuid} label={`GPU ${gpu.index}`} name={gpu.name} gpu={gpu} />)}
          {inventory.slice(gpus.length).map((type, index) => <GpuRow key={`missing-${index}`} label={`登记 GPU ${index + 1}`} name={gpus.length ? 'Slurm 登记设备' : type} />)}
        </section>
      })}
      {gpuNodes.length === 0 && <p className="slurm-no-gpu">无已知 GPU</p>}
    </div>
    <div id={id} hidden={!expanded} className="slurm-node-list">
      {resource.nodes.map(({ name: nodeName, node, sample }) => <section key={nodeName}>
        <h4>{nodeName} <small>{node?.state}</small></h4>
        <CpuReading percent={sample?.system.cpuUtilization ?? null} allocated={node?.cpuAllocated ?? null} total={node?.cpuTotal ?? null} />
      </section>)}
      {resource.nodes.length === 0 && <p className="slurm-no-gpu">此分区暂无节点</p>}
    </div>
  </article>
}

function CpuReading({ percent, allocated, total }: { percent: number | null; allocated: number | null; total: number | null }) {
  const value = percent === null || !Number.isFinite(percent) ? null : clampPercent(percent)
  return <div className="fleet-system slurm-cpu">
    <div><span>CPU</span><strong>{value === null ? '无采样' : `${value.toFixed(0)}%`}</strong><i aria-hidden="true"><b style={{ width: `${value ?? 0}%` }} /></i></div>
    {allocated !== null && total !== null && <small>调度分配 {allocated} / {total} CPU</small>}
  </div>
}

function GpuRow({ label, name, gpu }: { label: string; name: string; gpu?: GpuMetric }) {
  const available = !!gpu && isGpuAvailable(gpu)
  const memory = available && Number.isFinite(gpu.memoryUsedMb) && Number.isFinite(gpu.memoryTotalMb) && gpu.memoryTotalMb > 0 ? gpuMemoryPercent(gpu) : null
  const utilization = available && Number.isFinite(gpu.utilization) ? clampPercent(gpu.utilization) : null
  const memText = memory === null ? '无采样' : `${displayedGpuMemoryPercent(memory)}%`
  const memoryStyle = memory === null ? undefined : { '--memory-fill': `${memory}%` } as CSSProperties
  return <div className={`fleet-gpu-row ${memory === null ? 'fleet-gpu-row--unavailable' : `fleet-gpu-row--${gpuMemoryLevel(memory)}`}`} style={memoryStyle}>
    <span><strong>{label}</strong><small title={name}>{name}</small></span>
    <span>{memText}{memory !== null && gpu && <small>{(gpu.memoryUsedMb / 1024).toFixed(1)} / {(gpu.memoryTotalMb / 1024).toFixed(1)} GiB</small>}</span>
    <span className={utilization === null ? undefined : `fleet-gpu-row__load fleet-gpu-row__load--${gpuLoadLevel(utilization)}`}>{utilization === null ? '无采样' : `${utilization.toFixed(0)}%`}</span>
  </div>
}
