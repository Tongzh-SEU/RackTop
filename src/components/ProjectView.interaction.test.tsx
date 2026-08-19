// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, Server } from '../types/models'
import { ProjectView } from './ProjectView'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub

const source: Server = {
  id: 'source',
  name: 'Source',
  host: '10.0.0.1',
  port: 22,
  username: 'alice',
  tags: [],
  samplingIntervalSeconds: 2,
  historyRetentionDays: 90,
  remoteHistoryEnabled: false,
  authMethod: 'sshAgent',
  status: 'online',
}

const project: Project = {
  id: 'project',
  name: 'Training',
  kind: 'project',
  sourceServerId: source.id,
  sourcePath: '~/training',
  sourceExists: true,
  sourceIsDirectory: true,
  sourceSizeBytes: 10,
  sourceFileCount: 1,
  datasetIds: [], modelIds: [],
  targets: [],
  createdAt: 1,
  updatedAt: 1,
  status: 'synced',
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ProjectView inspection feedback', () => {
  it('keeps the refresh icon spinning until remote inspection finishes', async () => {
    let finishInspection: (() => void) | undefined
    const inspection = new Promise<void>((resolve) => { finishInspection = resolve })
    const onInspect = vi.fn(() => inspection)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => root?.render(<ProjectView projects={[project]} servers={[source]} busyTargets={new Set()} syncProgress={[]} preparingProjectIds={new Set()} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onInspect={onInspect} onSync={vi.fn()} onCancel={vi.fn()} onSyncAll={vi.fn()} />))
    const inspectButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '检查状态')

    await act(async () => inspectButton?.click())
    expect(onInspect).toHaveBeenCalledWith(project)
    expect(inspectButton?.textContent).toBe('检查中')
    expect(inspectButton?.querySelector('svg')?.classList.contains('spin')).toBe(true)
    expect(inspectButton?.disabled).toBe(true)

    await act(async () => finishInspection?.())
    expect(inspectButton?.textContent).toBe('检查状态')
    expect(inspectButton?.querySelector('svg')?.classList.contains('spin')).toBe(false)
    expect(inspectButton?.disabled).toBe(false)
  })
})
