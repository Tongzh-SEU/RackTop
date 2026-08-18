import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ManagedProcessView } from './ManagedProcessView'

describe('ManagedProcessView layout boundary', () => {
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
        datasetIds: [],
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
