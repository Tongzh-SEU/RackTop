import { describe, expect, it, vi } from 'vitest'
import { afterNextPaint } from './afterPaint'

describe('afterNextPaint', () => {
  it('waits until the frame after the loading state can be painted', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const callback = vi.fn()

    afterNextPaint(callback)
    expect(callback).not.toHaveBeenCalled()
    frames.shift()?.(0)
    expect(callback).not.toHaveBeenCalled()
    frames.shift()?.(16)
    expect(callback).toHaveBeenCalledOnce()

    vi.unstubAllGlobals()
  })

  it('cancels both scheduled frames when the view changes', () => {
    const frames: FrameRequestCallback[] = []
    let frameId = 0
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      frameId += 1
      return frameId
    }))
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)

    const dispose = afterNextPaint(vi.fn())
    frames.shift()?.(0)
    dispose()
    expect(cancel).toHaveBeenCalledWith(1)
    expect(cancel).toHaveBeenCalledWith(2)

    vi.unstubAllGlobals()
  })
})
