export type ServerDropPlacement = 'before' | 'after'
export interface ServerDropRow { id: string; top: number; bottom: number }

export function previewServerOrder<T extends { id: string; sortOrder?: number }>(items: T[], sourceId: string, targetId: string, placement: ServerDropPlacement): T[] {
  if (!sourceId || sourceId === targetId) return items
  const moved = items.find((item) => item.id === sourceId)
  if (!moved) return items

  const remaining = items.filter((item) => item.id !== sourceId)
  const targetIndex = remaining.findIndex((item) => item.id === targetId)
  if (targetIndex < 0) return items
  remaining.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, moved)
  if (remaining.every((item, index) => item.id === items[index]?.id)) return items
  return remaining.map((item, index) => ({ ...item, sortOrder: index }))
}

export function serverDropTarget(rows: ServerDropRow[], pointerY: number): { targetId: string; placement: ServerDropPlacement } | null {
  if (rows.length === 0) return null
  const target = rows.find((row) => pointerY <= row.bottom) ?? rows[rows.length - 1]
  return { targetId: target.id, placement: pointerY < target.top + (target.bottom - target.top) / 2 ? 'before' : 'after' }
}
