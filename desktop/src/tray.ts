/**
 * The menu bar item.
 *
 * The icon is a macOS *template* image: a black-and-transparent PNG whose name ends in
 * `Template`, which the system recolours for light and dark menu bars and for the highlighted
 * state. Shipping a coloured icon instead is the usual way a menu bar app ends up invisible on one
 * of the two appearances.
 *
 * The menu's contents come from trayMenu.ts; this file is the Electron binding and the click
 * handlers, so that the labelling rules stay testable on their own.
 */

import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from 'electron'
import * as path from 'path'
import { type MenuItemId, type MenuModel } from './trayMenu'

export type TrayHandlers = Partial<Record<MenuItemId, () => void>>

export interface TrayController {
  update: (model: MenuModel) => void
  destroy: () => void
}

/** `assetDir` holds trayTemplate.png / trayTemplate@2x.png. */
export function createTray(assetDir: string, handlers: TrayHandlers): TrayController {
  const image = nativeImage.createFromPath(path.join(assetDir, 'trayTemplate.png'))
  // Marks it as a template so macOS, not us, decides the colour for the current menu bar.
  image.setTemplateImage(true)
  const tray = new Tray(image)

  const update = (model: MenuModel) => {
    tray.setToolTip(model.tooltip)
    const template: MenuItemConstructorOptions[] = model.items.map(item => {
      if ('separator' in item) return { type: 'separator' }
      return {
        label: item.label,
        enabled: item.enabled,
        ...(item.checked === undefined ? {} : { type: 'checkbox' as const, checked: item.checked }),
        ...(item.accessibilityLabel === undefined ? {} : { accessibilityLabel: item.accessibilityLabel }),
        click: item.isStatus ? undefined : handlers[item.id],
      }
    })
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  return { update, destroy: () => tray.destroy() }
}
