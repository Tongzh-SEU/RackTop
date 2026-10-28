// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSheet } from '../App'
import type { AppSettings } from '../types/models'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: AppSettings = {
  defaultSamplingIntervalSeconds: 2,
  backgroundSamplingIntervalSeconds: 15,
  processIntervalSeconds: 5,
  realtimeWindowMinutes: 30,
  historyEnabled: true,
  historyRetentionDays: 90,
  idleGpuThreshold: 10,
  idleMemoryThresholdMb: 40960,
  idleDurationMinutes: 10,
  temperatureThresholdCelsius: 85,
  currentUserAccent: '#0a84ff',
  theme: 'system',
  fontSize: 'standard',
  menuBarMode: 'compact',
  reduceMotion: false,
  showAddServerGuide: true,
}

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('SettingsSheet onboarding settings', () => {
  it('shows the current app zoom instead of font size and changes zoom immediately', async () => {
    const onZoomChange = vi.fn()
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SettingsSheet settings={settings} zoom={0.85} onZoomChange={onZoomChange} onboardingVisible onClose={vi.fn()} onSave={vi.fn()} />))
    expect(container.textContent).not.toContain('字体大小')
    const slider = container.querySelector<HTMLInputElement>('[aria-label="设置界面缩放"]')!
    expect(slider.type).toBe('range')
    expect(slider.value).toBe('85')
    expect([slider.min, slider.max, slider.step]).toEqual(['50', '200', '5'])
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setNativeValue.call(slider, '200'); slider.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onZoomChange).toHaveBeenCalledWith(2)
    await act(async () => { setNativeValue.call(slider, '50'); slider.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(onZoomChange).toHaveBeenLastCalledWith(0.5)
  })

  it('defaults to three cards and saves the selected maximum', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SettingsSheet settings={settings} onboardingVisible onClose={vi.fn()} onSave={onSave} />))
    const select = [...container.querySelectorAll('label')].find((label) => label.textContent?.includes('每行最多卡片数'))!.querySelector('select')!
    expect(select.value).toBe('3')
    expect([...select.options].map((option) => option.value)).toEqual(['2', '3', '4', '5'])
    expect([...select.options].map((option) => option.textContent)).toEqual(['2 片', '3 片', '4 片', '5 片'])
    await act(async () => { select.value = '5'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    const save = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存设置')!
    await act(async () => save.click())
    expect(onSave).toHaveBeenCalledWith({ ...settings, maxCardsPerRow: 5 }, true)
  })

  it('keeps both onboarding switches in General and saves their values', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<SettingsSheet settings={settings} onboardingVisible onClose={vi.fn()} onSave={onSave} />))

    const groups = [...container.querySelectorAll<HTMLElement>('.settings-group')]
    expect(groups[0].textContent).toContain('通用')
    expect(groups[0].textContent).toContain('显示新手引导')
    expect(groups[0].textContent).toContain('显示添加服务器引导')
    expect(groups[1].textContent).not.toContain('显示添加服务器引导')

    const onboardingSwitch = [...groups[0].querySelectorAll('label')].find((label) => label.textContent?.includes('显示新手引导'))?.querySelector<HTMLInputElement>('input')
    expect(onboardingSwitch?.checked).toBe(true)
    await act(async () => onboardingSwitch?.click())
    expect(onboardingSwitch?.checked).toBe(false)

    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存设置')
    await act(async () => { saveButton?.click(); await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith(settings, false)
  })
  it('offers system MEM thresholds from 80 to 100 and hides them with the master switch', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SettingsSheet settings={settings} onboardingVisible onClose={vi.fn()} onSave={onSave} />))
    const slider = container.querySelector<HTMLInputElement>('[aria-label="系统 MEM 告警阈值"]')!
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['80','100','1','90'])
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const percent of ['80','100']) {
      await act(async () => { setNativeValue.call(slider, percent); slider.dispatchEvent(new Event('input', {bubbles:true})) })
      expect(slider.closest('label')?.textContent).toContain(`${percent}%`)
    }
    const master = [...container.querySelectorAll('label')].find(label=>label.textContent?.includes('启用空闲与告警通知'))!.querySelector<HTMLInputElement>('input')!
    await act(async () => master.click())
    expect(container.querySelector('[aria-label="系统 MEM 告警阈值"]')).toBeNull()
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='保存设置')!
    await act(async () => save.click())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({systemMemoryThresholdPercent:100,idleNotificationsEnabled:false}),true)
  })

})
