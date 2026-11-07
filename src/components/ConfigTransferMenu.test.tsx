// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import type { DragDropEvent } from '@tauri-apps/api/webview'
import tauriConfig from '../../src-tauri/tauri.conf.json'
import tauriLinuxConfig from '../../src-tauri/tauri.linux.conf.json'
import tauriWindowsConfig from '../../src-tauri/tauri.windows.conf.json'
import { ConfigTransferMenu } from './ConfigTransferMenu'
import { api } from '../services/api'
import type { Server, ServerDraft } from '../types/models'

vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: vi.fn() }))
vi.mock('../services/api', () => ({ api: { listServers: vi.fn(), exportServerConfig: vi.fn(), prepareServerConfigImport: vi.fn(), commitServerConfigImport: vi.fn(), discardServerConfigImport: vi.fn().mockResolvedValue(undefined), saveServer: vi.fn(), parseSshConfig: vi.fn(), readConfigTransferFile: vi.fn() } }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
const server: Server = { id: 'existing', name: 'Existing', host: '127.0.0.1', port: 22, username: 'tester', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'privateKey', identityFile: '/fixture/key', status: 'unknown' }
const onNotice = vi.fn()
const onImported = vi.fn().mockResolvedValue(undefined)
let nativeDropHandler: ((event: { payload: DragDropEvent }) => void) | undefined
const unlistenNativeDrop = vi.fn()
function configuredDragDrop(config: unknown) {
  return (config as { app: { windows: Array<{ dragDropEnabled?: boolean }> } }).app.windows[0].dragDropEnabled
}

function mount() {
  vi.mocked(api.discardServerConfigImport).mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<ConfigTransferMenu servers={[server]} onNotice={onNotice} onImported={onImported} />))
}
function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function click(text: string) { act(() => button(text).click()) }
function fill(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function dropFile(contents: string, name: string, selector = '.transfer-dropzone') {
  const file = new File([contents], name)
  Object.defineProperty(file, 'text', { value: async () => contents })
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } })
  await act(async () => document.querySelector(selector)!.dispatchEvent(event))
  return event
}

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  nativeDropHandler = undefined
  vi.resetAllMocks()
})

describe('configuration quick menu', () => {
  it('keeps native macOS drag handling and disables it only on Windows and Linux', () => {
    expect(configuredDragDrop(tauriConfig)).toBeUndefined()
    expect(configuredDragDrop(tauriWindowsConfig)).toBe(false)
    expect(configuredDragDrop(tauriLinuxConfig)).toBe(false)
  })

  it('loads a dropped configuration anywhere inside the import dialog', async () => {
    mount()
    click('导入 / 导出配置')
    click('导入配置')

    const event = await dropFile('encrypted-package', 'racktop-config.json', '.transfer-backdrop')

    expect(event.defaultPrevented).toBe(true)
    expect(document.body.textContent).toContain('racktop-config.json')
    expect(document.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('loads a Mac native file drop through the Tauri path event', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    vi.mocked(api.readConfigTransferFile).mockResolvedValue({ name: 'racktop-config.json', contents: 'encrypted-package' })
    vi.mocked(getCurrentWebview).mockReturnValue({
      onDragDropEvent: vi.fn(async (handler: (event: { payload: DragDropEvent }) => void) => {
        nativeDropHandler = handler
        return unlistenNativeDrop
      }),
    } as unknown as ReturnType<typeof getCurrentWebview>)
    mount()
    click('导入 / 导出配置')
    click('导入配置')
    await act(async () => { await Promise.resolve() })

    expect(nativeDropHandler).toBeDefined()
    await act(async () => {
      nativeDropHandler!({ payload: { type: 'drop', paths: ['/Users/tester/Downloads/racktop-config.json'], position: new PhysicalPosition(10, 10) } })
      await vi.waitFor(() => expect(api.readConfigTransferFile).toHaveBeenCalledWith('/Users/tester/Downloads/racktop-config.json'))
    })
    expect(document.body.textContent).toContain('racktop-config.json')
    expect(document.querySelector('input[type="password"]')).not.toBeNull()

    await act(async () => root.render(<></>))
    expect(unlistenNativeDrop).toHaveBeenCalledOnce()
  })

  it.each(['ssh', 'racktop'])('allows a resolved jump route in %s imports', async (kind) => {
    const routed: ServerDraft = { name: 'Routed', host: 'target.example', port: 22, username: 'tester', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent', proxyJump: 'jump@jump.example:2222', sshHops: [{ host: 'jump.example', port: 2222, username: 'jump', authMethod: 'sshAgent' }] }
    vi.mocked(api.parseSshConfig).mockResolvedValue([routed])
    vi.mocked(api.prepareServerConfigImport).mockResolvedValue({ importId: 'routed', privateKeyCount: 0, servers: [{ draft: routed, includesPrivateKey: false }] })
    vi.mocked(api.commitServerConfigImport).mockResolvedValue({ importedCount: 1, privateKeysInstalled: 0 })
    vi.mocked(api.saveServer).mockResolvedValue(server)
    mount(); click('导入 / 导出配置'); click(kind === 'ssh' ? '导入 SSH Config' : '导入配置')
    await dropFile('fixture', 'config')
    if (kind === 'racktop') { fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'migration-password'); await act(async () => button('验证配置包').click()) }
    const choice = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(choice.checked).toBe(true); expect(choice.disabled).toBe(false)
    await act(async () => button('导入 1 台').click())
    if (kind === 'racktop') expect(api.commitServerConfigImport).toHaveBeenCalledWith('routed', [0])
    else expect(api.saveServer).toHaveBeenCalledWith(expect.objectContaining({ sshHops: routed.sshHops }))
  })

  it.each(['ssh', 'racktop'])('imports the direct host from a mixed %s file while disabling jump dependencies', async (kind) => {
    const direct: ServerDraft = { name: 'Direct', host: 'direct.example', port: 22, username: 'tester', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent' }
    const jump = { ...direct, name: 'Via jump', host: 'jump-target.example', proxyJump: 'source-jump' }
    vi.mocked(api.parseSshConfig).mockResolvedValue([direct, jump])
    vi.mocked(api.prepareServerConfigImport).mockResolvedValue({ importId: 'mixed', privateKeyCount: 0, servers: [
      { draft: direct, includesPrivateKey: false },
      { draft: jump, includesPrivateKey: false, blockedReason: '跳板机需在目标电脑重新配置' },
    ] })
    vi.mocked(api.commitServerConfigImport).mockResolvedValue({ importedCount: 1, privateKeysInstalled: 0 })
    vi.mocked(api.saveServer).mockResolvedValue(server)
    mount()
    click('导入 / 导出配置')
    click(kind === 'ssh' ? '导入 SSH Config' : '导入配置')
    await dropFile('fixture', 'config')
    if (kind === 'racktop') {
      fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'migration-password')
      await act(async () => button('验证配置包').click())
    }
    const choices = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(choices).toHaveLength(2)
    expect(choices[0].checked).toBe(true)
    expect(choices[0].disabled).toBe(false)
    expect(choices[1].checked).toBe(false)
    expect(choices[1].disabled).toBe(true)
    expect(document.body.textContent).toContain('跳板机需在目标电脑重新配置')
    expect(document.body.textContent).toContain('已选 1 / 1 台')
    act(() => choices[1].click())
    expect(choices[1].checked).toBe(false)
    await act(async () => button('导入 1 台').click())
    if (kind === 'racktop') expect(api.commitServerConfigImport).toHaveBeenCalledWith('mixed', [0])
    else {
      expect(api.saveServer).toHaveBeenCalledTimes(1)
      expect(api.saveServer).toHaveBeenCalledWith(expect.objectContaining({ host: direct.host }))
    }
    expect(onImported).toHaveBeenCalledWith(1)
  })

  it.each(['ssh', 'racktop'])('refreshes partial %s imports and retries only the remaining selection', async (kind) => {
    const first: ServerDraft = { name: 'First', host: 'first.example', port: 22, username: 'tester', tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, authMethod: 'sshAgent' }
    const second = { ...first, host: 'second.example' }
    vi.mocked(api.listServers).mockResolvedValue([{ ...server, host: first.host }])
    vi.mocked(api.saveServer).mockResolvedValueOnce(server).mockRejectedValueOnce('injected').mockResolvedValueOnce(server)
    vi.mocked(api.parseSshConfig).mockResolvedValue([first, second])
    vi.mocked(api.prepareServerConfigImport).mockResolvedValue({ importId: 'partial', privateKeyCount: 0, servers: [first, second].map(draft => ({ draft, includesPrivateKey: false })) })
    vi.mocked(api.commitServerConfigImport).mockRejectedValueOnce('injected; first saved').mockResolvedValueOnce({ importedCount: 1, privateKeysInstalled: 0 })
    mount()
    click('导入 / 导出配置')
    click(kind === 'ssh' ? '导入 SSH Config' : '导入配置')
    await dropFile('fixture', 'config')
    if (kind === 'racktop') {
      fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'migration-password')
      await act(async () => button('验证配置包').click())
    }
    await act(async () => button('导入 2 台').click())
    expect(onImported).toHaveBeenCalledWith(1)
    const choices = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(choices[0].checked).toBe(false)
    expect(choices[1].checked).toBe(true)
    await act(async () => button('导入 1 台').click())
    if (kind === 'racktop') expect(api.commitServerConfigImport).toHaveBeenLastCalledWith('partial', [1])
    else expect(api.saveServer).toHaveBeenLastCalledWith(expect.objectContaining({ host: second.host }))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows the four prototype actions and does not report a cancelled save as exported', async () => {
    vi.mocked(api.exportServerConfig).mockResolvedValue(null)
    mount()
    click('导入 / 导出配置')
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(['导出配置.json', '导入配置', '导出 SSH Configconfig', '导入 SSH Config'])
    click('导出配置.json')
    const fields = [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input')]
    fill(fields[0], 'migration-password')
    fill(fields[1], 'different-password')
    expect(button('加密导出').disabled).toBe(true)
    fill(fields[1], 'migration-password')
    await act(async () => button('加密导出').click())
    expect(api.exportServerConfig).toHaveBeenCalledWith('migration-password', 'racktop')
    expect(onNotice).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button('导入 / 导出配置'))
  })

  it('exports SSH config without asking for a password', async () => {
    vi.mocked(api.exportServerConfig).mockResolvedValue({ path: '/fixture/ssh_config', serverCount: 1, privateKeyCount: 0 })
    mount()
    click('导入 / 导出配置')
    click('导出 SSH Configconfig')
    expect(document.querySelector('input[type="password"]')).toBeNull()
    await act(async () => button('导出').click())
    expect(api.exportServerConfig).toHaveBeenCalledWith('', 'ssh')
    expect(onNotice).toHaveBeenCalledWith('已导出 1 台 SSH Config')
  })

  it('keeps wrong-password errors visible and commits only the selected non-duplicate connection', async () => {
    const draft: ServerDraft = { name: server.name, host: server.host, port: server.port, username: server.username, tags: [...server.tags], samplingIntervalSeconds: server.samplingIntervalSeconds, historyRetentionDays: server.historyRetentionDays, remoteHistoryEnabled: server.remoteHistoryEnabled, authMethod: server.authMethod }
    vi.mocked(api.prepareServerConfigImport)
      .mockRejectedValueOnce('迁移密码错误或配置包已损坏')
      .mockResolvedValueOnce({ importId: 'pending', privateKeyCount: 1, servers: [{ draft, includesPrivateKey: true }, { draft: { ...draft, host: '127.0.0.2' }, includesPrivateKey: true }] })
    vi.mocked(api.commitServerConfigImport).mockResolvedValue({ importedCount: 1, privateKeysInstalled: 1 })
    mount()
    click('导入 / 导出配置')
    click('导入配置')
    const file = new File(['encrypted-package'], 'config.json')
    Object.defineProperty(file, 'text', { value: async () => 'encrypted-package' })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'wrong-password')
    await act(async () => button('验证配置包').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('密码错误')
    fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'correct-password')
    await act(async () => button('验证配置包').click())
    const choices = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(choices[0].disabled).toBe(true)
    expect(choices[0].checked).toBe(false)
    expect(choices[1].checked).toBe(true)
    await act(async () => button('导入 1 台').click())
    expect(api.commitServerConfigImport).toHaveBeenCalledWith('pending', [1])
    expect(onImported).toHaveBeenCalledWith(1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('requires a migration password after dropping an encrypted package and clears it when the file is removed', async () => {
    mount()
    click('导入 / 导出配置')
    click('导入配置')
    expect(document.querySelector('input[type="password"]')).toBeNull()
    await dropFile('encrypted-package', 'with-keys.json')
    const password = document.querySelector<HTMLInputElement>('input[type="password"]')!
    expect(password).not.toBeNull()
    expect(button('验证配置包').disabled).toBe(true)
    fill(password, 'migration-password')
    expect(button('验证配置包').disabled).toBe(false)
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="移除已选文件"]')!.click())
    expect(document.querySelector('input[type="password"]')).toBeNull()
    await dropFile('another-encrypted-package', 'other-keys.json')
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('')
    expect(button('验证配置包').disabled).toBe(true)
    expect(api.prepareServerConfigImport).not.toHaveBeenCalled()
  })

  it.each(['/Users/source/.ssh/private_key', '~/.ssh/id_ed25519', 'C:/Users/source/.ssh/id_ed25519'])('imports SSH config without the source alias or key path %s', async (identityFile) => {
    vi.mocked(api.parseSshConfig).mockResolvedValueOnce([{ name: 'source-alias', host: '127.0.0.3', port: 9, username: 'fixture', authMethod: 'sshConfig', sshAlias: 'source-alias', identityFile, tags: [], samplingIntervalSeconds: 2, historyRetentionDays: 90, remoteHistoryEnabled: false, savePassword: false }])
    mount()
    click('导入 / 导出配置')
    click('导入 SSH Config')
    await dropFile('Host source-alias\n HostName 127.0.0.3', 'config')
    expect(document.querySelector('input[type="password"]')).toBeNull()
    await act(async () => button('导入 1 台').click())
    expect(api.saveServer).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.3', sshAlias: undefined, identityFile: undefined, authMethod: 'sshAgent' }))
    expect(onImported).toHaveBeenCalledWith(1)
    expect(api.prepareServerConfigImport).not.toHaveBeenCalled()
  })
})
