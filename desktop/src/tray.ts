/**
 * The menu bar item.
 *
 * The icon is a macOS *template* image: a black-and-transparent PNG whose name ends in
 * `Template`, which the system recolours for light and dark menu bars and for the highlighted
 * state. Shipping a coloured icon instead is the usual way a menu bar app ends up invisible on one
 * of the two appearances.
 *
 * Linux recolours nothing either, and its panels are dark on some desktops and light on others,
 * so there the icon is the glyph on its teal tile (`trayLinux.png`), legible on both. Whether a
 * Linux panel shows the icon at all is a separate question — see trayHost.ts. Windows uses the
 * same tile as a multi-size .ico (`trayWindows.ico`), from which it picks the notification
 * area's size for the display's DPI.
 *
 * The menu's contents come from trayMenu.ts; this file is the Electron binding and the click
 * handlers, so that the labelling rules stay testable on their own.
 */

import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron'
import * as path from 'path'
import { type MenuItemId, type MenuModel } from './trayMenu'
import { trayIconFile } from './windows'

export type TrayHandlers = Partial<Record<MenuItemId, () => void>>

export interface TrayController {
  update: (model: MenuModel) => void
  destroy: () => void
}

/** `assetDir` holds trayTemplate.png / trayTemplate@2x.png (macOS), trayLinux.png /
 *  trayLinux@2x.png (Linux) and trayWindows.ico (Windows). */
export function createTray(assetDir: string, handlers: TrayHandlers): TrayController {
  const image = nativeImage.createFromPath(path.join(assetDir, trayIconFile(process.platform)))
  // Marks it as a template so macOS, not us, decides the colour for the current menu bar.
  if (process.platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image)
  // Windows convention: a left click on a notification-area icon opens the app; the menu is the
  // right click. (macOS and Linux show the menu on click.)
  if (process.platform === 'win32') tray.on('click', () => handlers['open-dashboard']?.())

  const update = (model: MenuModel) => {
    tray.setToolTip(model.tooltip)
    tray.setContextMenu(Menu.buildFromTemplate(menuTemplate(model, handlers)))
  }

  return { update, destroy: () => tray.destroy() }
}

/** The model as Electron menu items. Shared by the tray and, on Linux and Windows, the window's own
 *  menu bar — which is where the app's controls live when a Linux desktop has no tray. */
export function menuTemplate(model: MenuModel, handlers: TrayHandlers): MenuItemConstructorOptions[] {
  return model.items.map(item => {
    if ('separator' in item) return { type: 'separator' }
    return {
      label: item.label,
      enabled: item.enabled,
      ...(item.checked === undefined ? {} : { type: 'checkbox' as const, checked: item.checked }),
      ...(item.accessibilityLabel === undefined ? {} : { accessibilityLabel: item.accessibilityLabel }),
      click: item.isStatus ? undefined : handlers[item.id],
    }
  })
}
