// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, Server } from '../types/models'
import { ProjectForm } from './ProjectForm'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source: Server = { id: 'source', name: 'Source', host: '10.0.0.1', port: 22, username: 'alice', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent', status: 'online' }
const target: Server = { ...source, id: 'target', name: 'Target', host: '10.0.0.2' }
const alternateTarget: Server = { ...source, id: 'alternate-target', name: 'Alternate', host: '10.0.0.3' }
const dataset: Project = {
  id: 'dataset', name: 'Dataset', kind: 'dataset', sourceServerId: source.id, sourcePath: '~/datasets/source', sourceExists: true,
  sourceIsDirectory: true, sourceSizeBytes: 10, sourceFileCount: 1, datasetIds: [],
  targets: [{ serverId: target.id, path: '~/datasets/target', status: 'synced', exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1 }],
  createdAt: 1, updatedAt: 1, status: 'synced',
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ProjectForm focus management', () => {
  it('does not steal focus from an address when parent callbacks change', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const render = (onClose: () => void) => <ProjectForm initial={dataset} projects={[dataset]} servers={[source, target]} onClose={onClose} onSave={vi.fn()} />

    act(() => root?.render(render(vi.fn())))
    const targetPath = document.querySelector<HTMLInputElement>('[aria-label="Target 目标目录"]')
    expect(targetPath).not.toBeNull()
    act(() => targetPath?.focus())
    expect(document.activeElement).toBe(targetPath)
    expect(targetPath?.selectionStart).toBe(dataset.targets[0].path.length)
    expect(targetPath?.selectionEnd).toBe(dataset.targets[0].path.length)

    act(() => root?.render(render(vi.fn())))
    expect(document.activeElement).toBe(targetPath)
  })

  it('keeps unselected target servers visible and selectable', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => root?.render(<ProjectForm initial={dataset} projects={[dataset]} servers={[source, target, alternateTarget]} onClose={vi.fn()} onSave={vi.fn()} />))
    const rows = [...document.querySelectorAll<HTMLElement>('.project-target-row')]
    expect(rows).toHaveLength(2)
    const alternateRow = rows.find((row) => row.textContent?.includes('Alternate'))
    expect(alternateRow?.textContent).toContain('选择后设置目标目录')

    const checkbox = alternateRow?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    act(() => checkbox?.click())
    expect(alternateRow?.querySelector<HTMLInputElement>('[aria-label="Alternate 目标目录"]')).not.toBeNull()
  })
})
