import { clampPercent } from '../utils/gpu'

interface MetricBarProps {
  label: string
  value: number
  detail?: string
  accent?: 'blue' | 'green' | 'orange' | 'red' | 'purple'
  currentUserValue?: number
}

export function MetricBar({ label, value, detail, accent = 'blue', currentUserValue = 0 }: MetricBarProps) {
  const safeValue = clampPercent(value)
  const ownValue = Math.min(safeValue, clampPercent(currentUserValue))

  return (
    <div className="metric-bar" aria-label={`${label} ${Math.round(safeValue)}%`}>
      <div className="metric-bar__header">
        <span>{label}</span>
        <span className="metric-bar__value">{detail ?? `${Math.round(safeValue)}%`}</span>
      </div>
      <div className="metric-bar__track">
        <span className={`metric-bar__fill metric-bar__fill--${accent}`} style={{ width: `${safeValue}%` }} />
        {ownValue > 0 && <span className="metric-bar__own" style={{ width: `${ownValue}%` }} title="当前用户" />}
      </div>
    </div>
  )
}
