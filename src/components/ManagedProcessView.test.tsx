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
})
