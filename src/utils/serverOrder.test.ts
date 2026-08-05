import { describe, expect, it } from 'vitest'
import { previewServerOrder } from './serverOrder'

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
})
