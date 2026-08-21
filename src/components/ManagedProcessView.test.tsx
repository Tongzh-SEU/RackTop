import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ManagedRun, Project } from '../types/models'
import { launchDependencyIssue, managedRunAfterRemoteStatus, ManagedProcessView } from './ManagedProcessView'

describe('ManagedProcessView layout boundary', () => {
  it('moves a missing remote run out of the active list instead of waiting forever', () => {
    const run: ManagedRun = {
      id: 'run', profileId: null, name: 'Training', projectId: null, serverId: 'server', gpuUuids: [], gpuIndices: [],
      workingDirectory: '/workspace', command: 'python train.py', pid: 1394031, logPath: '~/.racktop/runs/run/output.log', startedAt: 1, status: 'running',
    }

    expect(managedRunAfterRemoteStatus(run, { status: 'unknown', exitCode: null }, 100)).toMatchObject({ status: 'failed', endedAt: 100 })
  })

  it('blocks launch when a linked model has no target path on the selected server', () => {
    const base: Project = {
      id: 'project', name: 'Training', kind: 'project', sourceServerId: 'source', sourcePath: '~/training', sourceExists: true,
      sourceIsDirectory: true, sourceSizeBytes: 0, sourceFileCount: 0, datasetIds: [], modelIds: ['model'], targets: [],
      createdAt: 1, updatedAt: 1, status: 'found',
    }
    const model: Project = { ...base, id: 'model', name: 'Llama-3-8B', kind: 'model', modelIds: [], sourcePath: '~/models/Llama-3-8B' }

    expect(launchDependencyIssue(base, [base, model], 'target')).toContain('关联模型“Llama-3-8B”尚未配置')
    expect(launchDependencyIssue(base, [base, { ...model, targets: [{ serverId: 'target', path: '~/models/Llama-3-8B', status: 'missing', exists: false, isDirectory: false, sizeBytes: 0, fileCount: 0 }] }], 'target')).toBeNull()
  })

  it('keeps task launch in the page toolbar', () => {
    const markup = renderToStaticMarkup(<ManagedProcessView
      servers={[]}
      snapshots={{}}
      projects={[]}
      warnings={[]}
      onDismissWarning={() => {}}
      onOpenTerminal={() => {}}
      onNotice={() => {}}
      onRefreshServer={async () => {}}
    />)

    expect(markup).toContain('managed-process-toolbar')
    expect(markup).toContain('运行中')
    expect(markup).toContain('启动配置')
    expect(markup).toContain('最近结束')
    expect(markup).toContain('启动任务')
    expect(markup).not.toContain('topbar__actions')
  })

  it('organizes launch profiles around projects and gives empty projects a direct add action', () => {
    const markup = renderToStaticMarkup(<ManagedProcessView
      servers={[]}
      snapshots={{}}
      projects={[{
        id: 'project-meta-distill',
        name: 'MetaDistill',
        kind: 'project',
        sourceServerId: 'server-4090',
        sourcePath: '/home/tongzh/pycharm/MetaDistill',
        sourceExists: true,
        sourceIsDirectory: true,
        sourceSizeBytes: 0,
        sourceFileCount: 0,
    datasetIds: [], modelIds: [],
        targets: [],
        createdAt: 1,
        updatedAt: 1,
        status: 'found',
      }]}
      warnings={[]}
      initialTab="profiles"
      onDismissWarning={() => {}}
      onOpenTerminal={() => {}}
      onNotice={() => {}}
      onRefreshServer={async () => {}}
    />)

    expect(markup).toContain('managed-profile-workspace')
    expect(markup).toContain('MetaDistill')
    expect(markup).toContain('/home/tongzh/pycharm/MetaDistill')
    expect(markup).toContain('这个项目还没有启动配置')
    expect(markup).toContain('添加配置')
  })
})
