import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Project, Server } from '../types/models'
import { ProjectForm } from './ProjectForm'
import { formatProjectSize, projectCardState, ProjectView, projectCardRowSpan, sortProjectsByRecentUse, syncableProjectTargets } from './ProjectView'

const targetServer: Server = {
  id: 'target',
  name: 'Target',
  host: '10.0.0.2',
  port: 22,
  username: 'alice',
  tags: [],
  samplingIntervalSeconds: 2,
  historyRetentionDays: 90,
  remoteHistoryEnabled: false,
  authMethod: 'sshAgent',
  status: 'online',
}

const sourceServer: Server = { ...targetServer, id: 'source', name: 'Source', host: '10.0.0.1' }

const detachedProject: Project = {
  id: 'project-1',
  name: 'Training',
  kind: 'project',
  sourceServerId: 'removed-source',
  sourcePath: '~/training',
  sourceExists: false,
  sourceIsDirectory: true,
  sourceSizeBytes: 0,
  sourceFileCount: 0,
  datasetIds: [],
  targets: [{ serverId: targetServer.id, path: '~/training', status: 'unknown', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0 }],
  createdAt: 1,
  updatedAt: 2,
  status: 'error',
  lastError: '主服务器已移除',
}

const dataset: Project = {
  ...detachedProject,
  id: 'dataset-1',
  name: 'ImageNet',
  kind: 'dataset',
  sourceServerId: sourceServer.id,
  sourcePath: '~/datasets/ImageNet',
}

const model: Project = {
  ...detachedProject,
  id: 'model-1',
  name: 'Llama-3-8B',
  kind: 'model',
  sourceServerId: sourceServer.id,
  sourcePath: '~/models/Llama-3-8B',
}

describe('Project source removal', () => {
  it('sorts recently executed items first, then falls back to recently added', () => {
    const older = { ...detachedProject, id: 'older', name: 'Older', createdAt: 10 }
    const newer = { ...detachedProject, id: 'newer', name: 'Newer', createdAt: 30 }
    const recentlyRun = { ...detachedProject, id: 'recently-run', name: 'Recently run', createdAt: 1 }

    expect(sortProjectsByRecentUse([older, recentlyRun, newer], { 'recently-run': 100 }).map((item) => item.id)).toEqual(['recently-run', 'newer', 'older'])
  })

  it('shows projects, datasets, and models as separate tabs', () => {
    const markup = renderToStaticMarkup(<ProjectView projects={[detachedProject, dataset, model]} servers={[sourceServer, targetServer]} busyTargets={new Set()} syncProgress={[]} preparingProjectIds={new Set()} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onInspect={vi.fn()} onSync={vi.fn()} onCancel={vi.fn()} onSyncAll={vi.fn()} />)

    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('项目 <span>1</span>')
    expect(markup).toContain('数据集 <span>1</span>')
    expect(markup).toContain('模型 <span>1</span>')
    expect(markup).toContain('Training')
    expect(markup).not.toContain('ImageNet')
    expect(markup).not.toContain('Llama-3-8B')
  })

  it('uses the model tab when only model sync objects exist', () => {
    const markup = renderToStaticMarkup(<ProjectView projects={[model]} servers={[sourceServer, targetServer]} busyTargets={new Set()} syncProgress={[]} preparingProjectIds={new Set()} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onInspect={vi.fn()} onSync={vi.fn()} onCancel={vi.fn()} onSyncAll={vi.fn()} />)

    expect(markup).toContain('aria-selected="true">模型')
    expect(markup).toContain('Llama-3-8B')
    expect(markup).toContain('project-card__icon--model')
    expect(markup).not.toContain('启动 Llama-3-8B')
  })

  it('includes the grid row gap when calculating masonry spans', () => {
    expect(projectCardRowSpan(240, 4, 12)).toBe(16)
  })

  it('does not round small project files down to zero megabytes', () => {
    expect(formatProjectSize(512)).toBe('512 B')
    expect(formatProjectSize(3_072)).toBe('3.0 KB')
    expect(formatProjectSize(48 * 1_024)).toBe('48 KB')
  })

  it('keeps the project visible in a disabled gray state', () => {
    const markup = renderToStaticMarkup(<ProjectView projects={[detachedProject]} servers={[targetServer]} busyTargets={new Set()} syncProgress={[]} preparingProjectIds={new Set()} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onInspect={vi.fn()} onSync={vi.fn()} onCancel={vi.fn()} onSyncAll={vi.fn()} />)

    expect(markup).toContain('is-source-missing')
    expect(markup).toContain('主服务器已移除')
    expect(markup).toContain('需要重新选择')
    expect(markup).toContain('请先编辑')
  })

  it('requires choosing a replacement source in the editor', () => {
    const markup = renderToStaticMarkup(<ProjectForm initial={detachedProject} projects={[detachedProject]} servers={[targetServer]} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(markup).toContain('原主服务器已移除，请重新选择')
    expect(markup).toContain('class="is-invalid"')
    expect(markup).toContain('Target')
  })

  it('places target servers before linked datasets and explains the combined sync action', () => {
    const adding = renderToStaticMarkup(<ProjectForm projects={[dataset]} servers={[sourceServer, targetServer]} onClose={vi.fn()} onSave={vi.fn()} />)
    const editing = renderToStaticMarkup(<ProjectForm initial={{ ...detachedProject, sourceServerId: sourceServer.id }} projects={[dataset]} servers={[sourceServer, targetServer]} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(adding).toContain('缺失副本可随“保存并同步”一并补齐')
    expect(adding.indexOf('目标服务器')).toBeLessThan(adding.indexOf('关联数据集'))
    expect(editing).toContain('缺失副本可随“保存并同步”一并补齐')
    expect(editing.indexOf('目标服务器')).toBeLessThan(editing.indexOf('关联数据集'))
    expect(editing).toContain('project-dataset-row--editing')
  })

  it('does not report offline or failed targets as synced', () => {
    const project: Project = {
      ...detachedProject,
      targets: [
        { ...detachedProject.targets[0], status: 'offline' },
        { ...detachedProject.targets[0], serverId: 'failed', status: 'error' },
      ],
    }

    expect(projectCardState(project, false)).toEqual({ kind: 'error', label: '2 个异常' })
    expect(syncableProjectTargets(project).map((target) => target.serverId)).toEqual(['failed'])
  })

  it('places path status below editable addresses instead of reserving a separate column', () => {
    const markup = renderToStaticMarkup(<ProjectForm initial={dataset} projects={[dataset]} servers={[sourceServer, targetServer]} onClose={vi.fn()} onSave={vi.fn()} />)

    expect(markup).toContain('class="project-source-path"')
    expect(markup).toContain('alice@10.0.0.1')
    expect(markup).toContain('class="project-target-path"')
    expect(markup).toContain('aria-label="主目录"')
    expect(markup).toContain('aria-label="Target 目标目录"')
  })

  it('shows one-click and animated preparation states on the card', () => {
    const project: Project = { ...detachedProject, sourceServerId: sourceServer.id, sourceExists: true, status: 'found', lastError: null }
    const markup = renderToStaticMarkup(<ProjectView projects={[project]} servers={[sourceServer, targetServer]} busyTargets={new Set()} syncProgress={[]} preparingProjectIds={new Set([project.id])} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onInspect={vi.fn()} onSync={vi.fn()} onCancel={vi.fn()} onSyncAll={vi.fn()} />)

    expect(markup).toContain('is-syncing')
    expect(markup).toContain('准备同步')
    expect(markup).toContain('正在检测路径，随后开始同步')
    expect(markup).toMatch(/class="[^"]*\bspin\b[^"]*"/)
  })

  it('keeps source metadata in three columns and exposes transfer progress', () => {
    const project: Project = {
      ...detachedProject,
      sourceServerId: sourceServer.id,
      sourceExists: true,
      sourceSizeBytes: 48 * 1_024,
      sourceModifiedAt: 1_723_305_480,
      status: 'syncing',
      targets: [{ ...detachedProject.targets[0], status: 'syncing' }],
    }
    const markup = renderToStaticMarkup(<ProjectView projects={[project]} servers={[sourceServer, targetServer]} busyTargets={new Set([`${project.id}:${targetServer.id}`])} syncProgress={[{ projectId: project.id, targetServerId: targetServer.id, transferredBytes: 31 * 1_024, resumedBytes: 12 * 1_024, totalBytes: 48 * 1_024, startedAt: Math.floor(Date.now() / 1_000) - 10, state: 'transferring' }]} preparingProjectIds={new Set()} onAdd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onInspect={vi.fn()} onSync={vi.fn()} onCancel={vi.fn()} onSyncAll={vi.fn()} />)

    expect(markup).toContain('project-card__source-summary')
    expect(markup).toContain('<small>主服务器</small>')
    expect(markup).toContain('<small>数据量</small>')
    expect(markup).toContain('<small>最近内容修改</small>')
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('31 KB / 48 KB')
    expect(markup).toContain('暂停同步到 Target')
  })
})
