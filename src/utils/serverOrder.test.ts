import { describe, expect, it } from 'vitest'
import { previewServerOrder, serverDropTarget } from './serverOrder'

const servers = ['a', 'b', 'c'].map((id, sortOrder) => ({ id, sortOrder }))

describe('previewServerOrder', () => {
  it('previews insertion before a target while preserving contiguous sort indexes', () => {
    const result = previewServerOrder(servers, 'c', 'a', 'before')
    expect(result.map((item) => item.id)).toEqual(['c', 'a', 'b'])
    expect(result.map((item) => item.sortOrder)).toEqual([0, 1, 2])
  })

  it('supports dropping after the final target', () => {
    expect(previewServerOrder(servers, 'a', 'c', 'after').map((item) => item.id)).toEqual(['b', 'c', 'a'])
  })

  it('returns the same array when the requested preview does not change order', () => {
    expect(previewServerOrder(servers, 'a', 'b', 'before')).toBe(servers)
  })

  it('resolves pointer positions to the nearest row half', () => {
    const rows = [
      { id: 'a', top: 10, bottom: 50 },
      { id: 'b', top: 50, bottom: 90 },
      { id: 'c', top: 90, bottom: 130 },
    ]
    expect(serverDropTarget(rows, 12)).toEqual({ targetId: 'a', placement: 'before' })
    expect(serverDropTarget(rows, 72)).toEqual({ targetId: 'b', placement: 'after' })
    expect(serverDropTarget(rows, 160)).toEqual({ targetId: 'c', placement: 'after' })
  })
})
