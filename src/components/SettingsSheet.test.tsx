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
})
