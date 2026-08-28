import { describe, expect, it } from 'vitest'
import type { ManagedRun } from '../types/models'
import { processBelongsToManagedRun, projectPathOnServer, projectWorkingDirectory, runMatchesProcess } from './managedRuns'

const run: ManagedRun = {
  id: 'run-1', name: '训练', serverId: 's1', gpuUuids: ['g0'], gpuIndices: [0], workingDirectory: '~/project',
  command: 'python train.py --config a100.yaml', pid: 4000, logPath: '~/.racktop/runs/run-1/output.log', startedAt: 1, status: 'running',
}

describe('managed runs', () => {
  it('matches the root, child, or distinctive command', () => {
    expect(runMatchesProcess(run, { pid: 4000, parentPid: 1, command: 'sh launch.sh' })).toBe(true)
    expect(runMatchesProcess(run, { pid: 4001, parentPid: 4000, command: 'python worker.py' })).toBe(true)
    expect(runMatchesProcess(run, { pid: 5000, parentPid: 1, command: 'python train.py --config a100.yaml' })).toBe(true)
    expect(runMatchesProcess(run, { pid: 5001, parentPid: 1, command: 'python unrelated.py' })).toBe(false)
  })

  it('resolves project paths per server', () => {
    const project = { sourceServerId: 'source', sourcePath: '~/projects/demo', targets: [{ serverId: 'target', path: '/data/demo' }] }
    expect(projectPathOnServer(project, 'source')).toBe('~/projects/demo')
    expect(projectPathOnServer(project, 'target')).toBe('/data/demo')
    expect(projectPathOnServer(project, 'missing')).toBe('')
  })

  it('uses the parent directory when a project is a single file', () => {
    const project = { sourceServerId: 'source', sourcePath: '~/projects/demo/main.py', sourceIsDirectory: false, targets: [{ serverId: 'target', path: '/data/demo/main.py' }] }
    expect(projectWorkingDirectory(project, 'source')).toBe('~/projects/demo')
    expect(projectWorkingDirectory(project, 'target')).toBe('/data/demo')
  })

  it('does not attach another user or another GPU to a managed run', () => {
    const process = { pid: 5000, parentPid: 1, command: 'python train.py --config a100.yaml' }
    expect(processBelongsToManagedRun('s1', { ...process, isCurrentUser: true, gpuUuid: 'g0' }, [run])).toBe(true)
    expect(processBelongsToManagedRun('s1', { ...process, isCurrentUser: false, gpuUuid: 'g0' }, [run])).toBe(false)
    expect(processBelongsToManagedRun('s1', { ...process, isCurrentUser: true, gpuUuid: 'g1' }, [run])).toBe(false)
  })
})
