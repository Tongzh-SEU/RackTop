// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, Server } from '../types/models'
import { api } from '../services/api'
import { ProjectForm } from './ProjectForm'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source: Server = { id: 'source', name: 'Source', host: '10.0.0.1', port: 22, username: 'alice', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent', status: 'online' }
const target: Server = { ...source, id: 'target', name: 'Target', host: '10.0.0.2' }
const alternateTarget: Server = { ...source, id: 'alternate-target', name: 'Alternate', host: '10.0.0.3' }
const dataset: Project = {
  id: 'dataset', name: 'Dataset', kind: 'dataset', sourceServerId: source.id, sourcePath: '~/datasets/source', sourceExists: true,
  sourceIsDirectory: true, sourceSizeBytes: 10, sourceFileCount: 1, datasetIds: [], modelIds: [],
  targets: [{ serverId: target.id, path: '~/datasets/target', status: 'synced', exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1 }],
  createdAt: 1, updatedAt: 1, status: 'synced',
}
const model: Project = {
  ...dataset,
  id: 'model',
  name: 'Model',
  kind: 'model',
  sourcePath: '~/models/source',
  targets: [{ ...dataset.targets[0], path: '~/models/target' }],
}

let container: HTMLDivElement | null = null
let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.restoreAllMocks()
})

describe('ProjectForm focus management', () => {
  it('creates models with the same server and directory workflow without dataset linking', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => root?.render(<ProjectForm projects={[dataset]} servers={[source, target]} onClose={vi.fn()} onSave={vi.fn()} />))
    const modelButton = [...document.querySelectorAll<HTMLButtonElement>('.project-kind-segmented button')].find((button) => button.textContent === '模型')
    act(() => modelButton?.click())

    expect(modelButton?.classList.contains('is-selected')).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[placeholder="例如：Llama-3-8B"]')).not.toBeNull()
    expect(document.body.textContent).toContain('目标服务器')
    expect(document.body.textContent).not.toContain('关联数据集')
  })

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

  it('allows path checks without a name but blocks save and highlights the name field', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const unnamed = { ...dataset, name: '' }
    const probe = vi.spyOn(api, 'probeProjectPaths').mockResolvedValue([
      { serverId: source.id, requestedPath: dataset.sourcePath, suggestedPath: dataset.sourcePath, exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1, matches: [] },
      { serverId: target.id, requestedPath: dataset.targets[0].path, suggestedPath: dataset.targets[0].path, exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1, matches: [] },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)

    act(() => root?.render(<ProjectForm initial={unnamed} projects={[unnamed]} servers={[source, target]} onClose={vi.fn()} onSave={onSave} />))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 300)) })
    probe.mockClear()

    const checkButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('检查配置'))
    await act(async () => { checkButton?.click(); await Promise.resolve() })
    expect(probe).toHaveBeenCalled()

    const syncButton = [...document.querySelectorAll<HTMLButtonElement>('.sheet__footer button')].find((button) => button.textContent?.includes('保存并同步'))
    await act(async () => { syncButton?.click(); await Promise.resolve() })
    const nameInput = document.querySelector<HTMLInputElement>('.project-identity-fields input')
    expect(nameInput?.getAttribute('aria-invalid')).toBe('true')
    expect(nameInput?.closest('label')?.textContent).toContain('数据集名称不能为空')
    expect(document.activeElement).toBe(nameInput)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('adds only missing dataset replicas to save and sync', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const project: Project = {
      ...dataset,
      id: 'project',
      kind: 'project',
      datasetIds: [dataset.id],
      targets: [
        { serverId: target.id, path: '~/projects/target', status: 'synced', exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1 },
        { serverId: alternateTarget.id, path: '~/projects/alternate', status: 'synced', exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1 },
      ],
    }
    vi.spyOn(api, 'probeProjectPaths').mockResolvedValue([
      { serverId: target.id, requestedPath: '~/datasets/target', suggestedPath: '~/datasets/target', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, matches: [] },
      { serverId: alternateTarget.id, requestedPath: '~/datasets/alternate', suggestedPath: '~/datasets/alternate', exists: true, isDirectory: true, sizeBytes: 10, fileCount: 1, matches: [] },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)

    act(() => root?.render(<ProjectForm initial={project} projects={[project, dataset]} servers={[source, target, alternateTarget]} onClose={vi.fn()} onSave={onSave} />))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 550)) })

    const syncPlan = [...document.querySelectorAll<HTMLLabelElement>('.project-dataset-row__sync')].find((label) => label.textContent?.includes('本次补齐'))
    expect(syncPlan).not.toBeNull()
    act(() => syncPlan?.querySelector<HTMLInputElement>('input')?.click())
    expect(document.querySelector('.sheet__footer')?.textContent).toContain('保存并同步（含 1 个数据集）')

    const syncButton = [...document.querySelectorAll<HTMLButtonElement>('.sheet__footer button')].find((button) => button.textContent?.includes('保存并同步'))
    await act(async () => { syncButton?.click(); await Promise.resolve() })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][1]).toBe(true)
    expect(onSave.mock.calls[0][2][0]).toMatchObject({
      resourceId: dataset.id,
      kind: 'dataset',
      syncOnSave: true,
      targets: [{ serverId: target.id, path: '~/datasets/target' }],
      registeredTargets: [{ serverId: alternateTarget.id, path: '~/datasets/alternate' }],
    })
  })

  it('links a dataset that is still syncing without scheduling a duplicate transfer', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const project: Project = { ...dataset, id: 'project-active-dataset', kind: 'project', datasetIds: [dataset.id] }
    vi.spyOn(api, 'probeProjectPaths').mockResolvedValue([
      { serverId: target.id, requestedPath: '~/datasets/target', suggestedPath: '~/datasets/target', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, matches: [] },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)

    act(() => root?.render(<ProjectForm initial={project} projects={[project, dataset]} servers={[source, target]} activeSyncTargets={new Set([`${dataset.id}:${target.id}`])} onClose={vi.fn()} onSave={onSave} />))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 550)) })

    expect(document.querySelector('.project-dataset-row__status')?.textContent).toContain('1 台正在同步')
    expect(document.querySelector('.project-dataset-row__sync')).toBeNull()
    const syncButton = [...document.querySelectorAll<HTMLButtonElement>('.sheet__footer button')].find((button) => button.textContent?.includes('保存并同步'))
    await act(async () => { syncButton?.click(); await Promise.resolve() })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0].datasetIds).toEqual([dataset.id])
    expect(onSave.mock.calls[0][2][0]).toMatchObject({ resourceId: dataset.id, syncOnSave: false, targets: [] })
  })

  it('persists linked models and adds only missing model replicas to save and sync', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const project: Project = {
      ...dataset,
      id: 'project-model',
      kind: 'project',
      datasetIds: [],
      modelIds: [model.id],
    }
    vi.spyOn(api, 'probeProjectPaths').mockResolvedValue([
      { serverId: target.id, requestedPath: '~/models/target', suggestedPath: '~/models/target', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, matches: [] },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)

    act(() => root?.render(<ProjectForm initial={project} projects={[project, model]} servers={[source, target]} onClose={vi.fn()} onSave={onSave} />))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 550)) })

    const modelSection = document.querySelector<HTMLElement>('[aria-label="关联模型"]')
    expect(modelSection?.textContent).toContain('Model')
    act(() => modelSection?.querySelector<HTMLInputElement>('.project-dataset-row__sync input')?.click())
    expect(document.querySelector('.sheet__footer')?.textContent).toContain('保存并同步（含 1 个模型）')

    const syncButton = [...document.querySelectorAll<HTMLButtonElement>('.sheet__footer button')].find((button) => button.textContent?.includes('保存并同步'))
    await act(async () => { syncButton?.click(); await Promise.resolve() })
    expect(onSave.mock.calls[0][0].modelIds).toEqual([model.id])
    expect(onSave.mock.calls[0][2][0]).toMatchObject({
      resourceId: model.id,
      kind: 'model',
      syncOnSave: true,
      targets: [{ serverId: target.id, path: '~/models/target' }],
    })
  })

  it('keeps a planned dataset transfer dormant when choosing save only', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const project: Project = { ...dataset, id: 'project-save', kind: 'project', datasetIds: [dataset.id] }
    vi.spyOn(api, 'probeProjectPaths').mockResolvedValue([
      { serverId: target.id, requestedPath: '~/datasets/target', suggestedPath: '~/datasets/target', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, matches: [] },
    ])
    const onSave = vi.fn().mockResolvedValue(undefined)

    act(() => root?.render(<ProjectForm initial={project} projects={[project, dataset]} servers={[source, target]} onClose={vi.fn()} onSave={onSave} />))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 550)) })
    act(() => document.querySelector<HTMLInputElement>('.project-dataset-row__sync input')?.click())
    const saveButton = document.querySelector<HTMLButtonElement>('.sheet__footer button[type="submit"]')
    await act(async () => { saveButton?.click(); await Promise.resolve() })

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][1]).toBe(false)
    expect(onSave.mock.calls[0][2][0].syncOnSave).toBe(false)
  })

  it('keeps a single same-name candidate separate from a missing replica', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const project: Project = { ...dataset, id: 'project-candidate', kind: 'project', datasetIds: [dataset.id] }
    vi.spyOn(api, 'probeProjectPaths').mockResolvedValue([
      { serverId: target.id, requestedPath: '~/datasets/target', suggestedPath: '~/datasets/target', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0, matches: ['/home/alice/datasets/Dataset'] },
    ])

    act(() => root?.render(<ProjectForm initial={project} projects={[project, dataset]} servers={[source, target]} onClose={vi.fn()} onSave={vi.fn()} />))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 550)) })

    expect(document.querySelector('.project-dataset-row__status')?.textContent).toContain('1 台候选待确认')
    expect(document.querySelector('.project-dataset-row__sync')).toBeNull()
    expect(document.querySelector('.sheet__footer')?.textContent).not.toContain('含 1 个数据集')
  })
})
