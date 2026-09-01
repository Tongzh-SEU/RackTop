import { beforeEach, describe, expect, it, vi } from 'vitest'
import { popupServerContextMenu } from './serverContextMenu'
import { defaultServerNotificationSettings } from '../utils/serverNotifications'

const menuMocks = vi.hoisted(() => ({
  checkItems: [] as Array<Record<string, unknown>>,
  submenus: [] as Array<Record<string, unknown>>,
  popup: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/dpi', () => ({
  LogicalPosition: class LogicalPosition {
    constructor(public x: number, public y: number) {}
  },
}))

vi.mock('@tauri-apps/api/menu', () => ({
  CheckMenuItem: {
    new: vi.fn(async (options: Record<string, unknown>) => {
      menuMocks.checkItems.push(options)
      return options
    }),
  },
  MenuItem: { new: vi.fn(async (options: Record<string, unknown>) => options) },
  PredefinedMenuItem: { new: vi.fn(async (options: Record<string, unknown>) => options) },
  Submenu: {
    new: vi.fn(async (options: Record<string, unknown>) => {
      menuMocks.submenus.push(options)
      return options
    }),
  },
  Menu: { new: vi.fn(async () => ({ popup: menuMocks.popup, close: menuMocks.close })) },
}))

describe('server context menu', () => {
  beforeEach(() => {
    menuMocks.checkItems.length = 0
    menuMocks.submenus.length = 0
    menuMocks.popup.mockClear()
    menuMocks.close.mockClear()
  })

  it('opens partial notification editing from the two-level notification menu', async () => {
    const editPartialNotifications = vi.fn()
    await popupServerContextMenu(12, 34, { ...defaultServerNotificationSettings('server'), mode: 'partial', zombie: false }, {
      edit: vi.fn(),
      refresh: vi.fn(),
      openTerminal: vi.fn(),
      setNotificationMode: vi.fn(),
      editPartialNotifications,
      delete: vi.fn(),
    })

    expect(menuMocks.submenus).toHaveLength(1)
    expect(menuMocks.submenus[0]).toMatchObject({ text: '通知' })
    const notificationItems = menuMocks.submenus[0].items as Array<Record<string, unknown>>
    expect(notificationItems.map((item) => item.text)).toEqual(['打开', '关闭', '部分…'])
    expect(menuMocks.submenus.some((submenu) => submenu.text === '部分')).toBe(false)

    const partial = notificationItems[2]
    expect(partial.checked).toBe(true)
    ;(partial.action as () => void)()
    expect(editPartialNotifications).toHaveBeenCalledOnce()
    expect(menuMocks.popup).toHaveBeenCalledOnce()
    expect(menuMocks.close).toHaveBeenCalledOnce()
  })
})
