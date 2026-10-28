// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ManagedProcessView } from './ManagedProcessView'

vi.mock('../services/api', () => ({ api: { isDesktop: true } }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([
  ['GPU 数量', 'gpuCount'],
  ['每卡最低空闲显存', 'minimumGpuMemoryGb'],
])('%s allows clearing and normalizes leading zeros on blur', async (label, field) => {
  const key = 'racktop.launchProfiles.v1'
  const previous = localStorage.getItem(key)
  localStorage.setItem(key, JSON.stringify([{
    id: 'resource-input-test', name: '输入测试', workingDirectory: '~/projects', command: 'python train.py',
    gpuCount: 0, minimumGpuMemoryGb: 0, datasetIds: [], createdAt: 1, updatedAt: 1,
  }]))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const clickButton = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  try {
    await act(async () => root.render(<ManagedProcessView servers={[]} snapshots={{}} projects={[]}
      initialTab="profiles" onOpenTerminal={() => {}} onNotice={() => {}}
      onRefreshServer={async () => {}} />))
    await clickButton('调整并运行')
    const input = [...container.querySelectorAll('label')].find((item) => item.textContent === label)!
      .querySelector<HTMLInputElement>('input')!
    const change = async (value: string) => {
      await act(async () => {
        input.focus()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    expect(input.value).toBe('0')
    await change('')
    expect(input.value).toBe('')
    await act(async () => input.blur())
    expect(input.value).toBe('0')
    await change('02')
    expect(input.value).toBe('02')
    await act(async () => input.blur())
    expect(input.value).toBe('2')
    await clickButton('保存配置')
    expect(JSON.parse(localStorage.getItem(key)!)[0][field]).toBe(2)
    await clickButton('调整并运行')
    const reopened = [...container.querySelectorAll('label')].find((item) => item.textContent === label)!
      .querySelector<HTMLInputElement>('input')!
    expect(reopened.value).toBe('2')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    if (previous === null) localStorage.removeItem(key)
    else localStorage.setItem(key, previous)
  }
})
