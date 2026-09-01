import { describe, expect, it } from 'vitest'
import { appUpdatePercent, applyAppUpdateDownloadEvent, formatUpdateBytes, initialAppUpdateState } from './appUpdate'

describe('app update progress', () => {
  it('accumulates chunks and reports determinate progress', () => {
    let state = initialAppUpdateState('1.25.4')
    state = applyAppUpdateDownloadEvent(state, { event: 'Started', data: { contentLength: 1_000 } })
    state = applyAppUpdateDownloadEvent(state, { event: 'Progress', data: { chunkLength: 250 } })
    state = applyAppUpdateDownloadEvent(state, { event: 'Progress', data: { chunkLength: 250 } })
    expect(state.downloadedBytes).toBe(500)
    expect(appUpdatePercent(state)).toBe(50)
  })

  it('keeps unknown-size downloads indeterminate and advances to installation', () => {
    let state = applyAppUpdateDownloadEvent(initialAppUpdateState('1.25.4'), { event: 'Started', data: {} })
    state = applyAppUpdateDownloadEvent(state, { event: 'Progress', data: { chunkLength: 1_024 } })
    expect(appUpdatePercent(state)).toBeNull()
    expect(applyAppUpdateDownloadEvent(state, { event: 'Finished', data: {} }).phase).toBe('installing')
  })

  it('clamps malformed progress and formats compact byte labels', () => {
    const state = { ...initialAppUpdateState('1.25.4'), downloadedBytes: 2_000, totalBytes: 1_000 }
    expect(appUpdatePercent(state)).toBe(100)
    expect(formatUpdateBytes(1_572_864)).toBe('1.5 MB')
  })
})
