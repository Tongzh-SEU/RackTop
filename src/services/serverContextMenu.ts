import { LogicalPosition } from '@tauri-apps/api/dpi'
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from '@tauri-apps/api/menu'
import type { ServerNotificationMode, ServerNotificationSettings } from '../types/models'

export interface ServerContextMenuActions {
  edit: () => void
  refresh: () => void
  openTerminal: () => void
  setNotificationMode: (mode: ServerNotificationMode) => void
  editPartialNotifications: () => void
  delete: () => void
}

export async function popupServerContextMenu(x: number, y: number, notificationSettings: ServerNotificationSettings, actions: ServerContextMenuActions) {
  const [edit, refresh, terminal, notificationsAll, notificationsOff, notificationsPartial, separator, remove] = await Promise.all([
    MenuItem.new({ text: '编辑服务器…', action: actions.edit }),
    MenuItem.new({ text: '刷新', action: actions.refresh }),
    MenuItem.new({ text: '打开终端', action: actions.openTerminal }),
    CheckMenuItem.new({ text: '打开', checked: notificationSettings.mode === 'all', action: () => actions.setNotificationMode('all') }),
    CheckMenuItem.new({ text: '关闭', checked: notificationSettings.mode === 'off', action: () => actions.setNotificationMode('off') }),
    CheckMenuItem.new({ text: '部分…', checked: notificationSettings.mode === 'partial', action: actions.editPartialNotifications }),
    PredefinedMenuItem.new({ item: 'Separator' }),
    MenuItem.new({ text: '删除服务器…', action: actions.delete }),
  ])
  const notifications = await Submenu.new({ text: '通知', items: [notificationsAll, notificationsOff, notificationsPartial] })
  const menu = await Menu.new({ items: [edit, refresh, terminal, notifications, separator, remove] })
  try {
    await menu.popup(new LogicalPosition(x, y))
  } finally {
    await menu.close()
  }
}
