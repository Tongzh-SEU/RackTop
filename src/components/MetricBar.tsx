import type { CSSProperties } from 'react'
import { clampPercent } from '../utils/gpu'

interface MetricBarProps {
  label: string
  value: number
  detail?: string
  accent?: 'blue' | 'green' | 'orange' | 'red' | 'purple'
  currentUserValue?: number
  currentUserDetail?: string
}

export function MetricBar({ label, value, detail, accent = 'blue', currentUserValue = 0, currentUserDetail }: MetricBarProps) {
  const safeValue = clampPercent(value)
  const ownValue = clampPercent(currentUserValue)
  const showOwnMarker = ownValue > 0 && Boolean(currentUserDetail)

  return (
    <div className={`metric-bar ${showOwnMarker ? 'metric-bar--with-own-marker' : ''}`} aria-label={`${label} ${Math.round(safeValue)}%${showOwnMarker ? `，当前用户 ${currentUserDetail}` : ''}`}>
      <div className="metric-bar__header">
        <span>{label}</span>
        <span className="metric-bar__value">{detail ?? `${Math.round(safeValue)}%`}</span>
      </div>
      <div className="metric-bar__track">
        <span className={`metric-bar__fill metric-bar__fill--${accent}`} style={{ width: `${safeValue}%` }} />
        {showOwnMarker ? <>
          <span className="metric-bar__own-marker" style={{ '--own-position': `${ownValue}%` } as CSSProperties} title={`当前用户 ${currentUserDetail}`} />
          <span className="metric-bar__own-label" style={{ '--own-position': `${ownValue}%` } as CSSProperties} aria-hidden="true">你 {currentUserDetail}</span>
        </> : ownValue > 0 ? <span className="metric-bar__own" style={{ width: `${Math.min(safeValue, ownValue)}%` }} title="当前用户" /> : null}
      </div>
    </div>
  )
}
