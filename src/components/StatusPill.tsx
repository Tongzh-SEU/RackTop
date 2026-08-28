import type { ServerStatus } from '../types/models'

const labels: Record<ServerStatus, string> = {
  online: '在线',
  offline: '离线',
  connecting: '连接中',
  warning: '需注意',
  unknown: '未连接',
}

export function StatusPill({ status }: { status: ServerStatus }) {
  return (
    <span className={`status-pill status-pill--${status}`}>
      <span className="status-pill__dot" aria-hidden="true" />
      {labels[status]}
    </span>
  )
}
