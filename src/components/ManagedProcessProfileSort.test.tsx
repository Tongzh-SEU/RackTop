// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagedProcessView } from './ManagedProcessView'

vi.mock('../services/api', () => ({ api: { isDesktop: true } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const profileKey = 'racktop.launchProfiles.v1'
const sortKey = 'racktop.profileSort.v1'
const descendingKey = 'racktop.profileDescending.v1'
const container = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  container.remove()
  localStorage.clear()
})

it('defaults to creation ascending, switches both controls, and restores the selection', async () => {
  const base = { command: 'python train.py', workingDirectory: '~/projects', gpuCount: 0, minimumGpuMemoryGb: 0, datasetIds: [] }
  // Deliberately reversed IDs at equal timestamps ensure stored order cannot decide ties.
  localStorage.setItem(profileKey, JSON.stringify([
    { ...base, id: 'b', name: 'B', createdAt: 1, updatedAt: 30 },
    { ...base, id: 'a', name: 'A', createdAt: 1, updatedAt: 10 },
    { ...base, id: 'c', name: 'C', createdAt: 2, updatedAt: 20 },
  ]))
  document.body.append(container)
  const render = async () => {
    root = createRoot(container)
    await act(async () => root!.render(<ManagedProcessView servers={[]} snapshots={{}} projects={[]}
      initialTab="profiles" onOpenTerminal={() => {}} onNotice={() => {}} onRefreshServer={async () => {}} />))
  }
  const names = () => [...container.querySelectorAll('.managed-profile-template > header strong')].map((element) => element.textContent)
  await render()
  expect(names()).toEqual(['A', 'B', 'C'])
  const directionButton = container.querySelector<HTMLButtonElement>('[aria-label="当前升序，切换为降序"]')!
  expect(directionButton.textContent).toBe('')
  expect(directionButton.title).toBe('当前升序，点击切换为降序')
  expect(container.querySelector('.managed-profile-actions select')).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="当前按创建时间排序，切换为更新时间"]')!.click())
  expect(names()).toEqual(['A', 'C', 'B'])
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="当前升序，切换为降序"]')!.click())
  expect(names()).toEqual(['B', 'C', 'A'])
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="当前按更新时间排序，切换为创建时间"]')!.click())
  expect(names()).toEqual(['C', 'B', 'A'])
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="当前按创建时间排序，切换为更新时间"]')!.click())
  expect(names()).toEqual(['B', 'C', 'A'])
  expect(localStorage.getItem(sortKey)).toBe('updatedAt')
  expect(localStorage.getItem(descendingKey)).toBe('true')
  await act(async () => root!.unmount())
  await render()
  expect(names()).toEqual(['B', 'C', 'A'])
  await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent === '调整并运行')!.click())
  expect([...container.querySelectorAll('.managed-profile-group__items button > span')].map((element) => element.textContent)).toEqual(['B', 'C', 'A'])
})

it('ignores unsupported saved sort options', async () => {
  localStorage.setItem(sortKey, 'lastRun')
  localStorage.setItem(descendingKey, 'invalid')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<ManagedProcessView servers={[]} snapshots={{}} projects={[]}
    initialTab="profiles" onOpenTerminal={() => {}} onNotice={() => {}} onRefreshServer={async () => {}} />))
  expect(container.querySelector('[aria-label="当前按创建时间排序，切换为更新时间"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="当前升序，切换为降序"]')).not.toBeNull()
})
