// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../services/api'
import type { SlurmOverview } from '../types/models'
import { SlurmView } from './SlurmView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const overview: SlurmOverview = {
  username: 'actual-ssh-user',
  partitions: [{ name: 'gpu', nodeNames: ['worker-01'] }],
  nodes: {
    'worker-01': { hostname: 'worker-01', address: '10.0.0.1', state: 'DRAIN', cpuAllocated: 0, cpuTotal: 32, gpuTypes: [{ name: 'H100', count: 2 }] },
  },
  jobs: [
    { id: '1', user: 'actual-ssh-user', partition: 'gpu', cpus: 8, reason: 'Resources', name: 'mine' },
    { id: '2', user: 'someone-else', partition: 'gpu', cpus: 4, reason: 'Priority', name: 'other' },
  ],
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('groups the visible queue by the actual SSH user and shows each unsampled GPU', async () => {
  const collect = vi.spyOn(api, 'collectSlurm').mockResolvedValue(overview)
  await act(async () => root.render(<SlurmView serverId="login" servers={[]} snapshots={{}} />))
  expect(collect).toHaveBeenCalledExactlyOnceWith('login')
  expect(container.querySelector('.slurm-queue-own')?.textContent).toContain('actual-ssh-user')
  expect(container.querySelector('tbody:not(.slurm-queue-own)')?.textContent).toContain('someone-else')
  expect(container.querySelectorAll('.fleet-gpu-row--unavailable')).toHaveLength(2)
  const expand = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!
  await act(async () => expand.click())
  expect(container.querySelector<HTMLElement>('.slurm-node-list')?.hidden).toBe(false)
})

it('retains the last visible queue when a manual refresh fails', async () => {
  const collect = vi.spyOn(api, 'collectSlurm').mockResolvedValueOnce(overview).mockRejectedValueOnce('Slurm 查询超时')
  await act(async () => root.render(<SlurmView serverId="login" servers={[]} snapshots={{}} />))
  await act(async () => container.querySelector<HTMLButtonElement>('.slurm-heading button')!.click())
  expect(collect).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Slurm 查询超时')
  expect(container.querySelector('.slurm-queue')?.textContent).toContain('mine')
})
