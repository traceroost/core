/**
 * Which tray image to show, per platform and system appearance.
 *
 * macOS recolours a *template* image itself, so one black-on-transparent PNG serves both menu bar
 * appearances. Windows does no such thing: a tray icon is drawn as-is, and the default Windows 11
 * taskbar is dark, so the black glyph that is right for macOS would be invisible there. The
 * Windows build therefore ships two ICOs and the shell picks by the *system UI* appearance — the
 * taskbar follows Windows' "system" colour mode, which is a separate setting from the "app" mode
 * that `nativeTheme.shouldUseDarkColors` reports; Electron exposes the right one as
 * `shouldUseDarkColorsForSystemIntegratedUI`.
 *
 * Kept free of `electron` imports so the choice is a unit-testable function; tray.ts supplies the
 * platform and the theme flag and re-asks on `nativeTheme`'s `updated` event.
 */

import * as path from 'path'

export interface TrayIconChoice {
  /** Path of the image file to load, inside the app's `build/` asset directory. */
  file: string
  /** Whether to mark the image as a macOS template image. */
  template: boolean
}

export function chooseTrayIcon(assetDir: string, platform: NodeJS.Platform, darkSystemUi: boolean): TrayIconChoice {
  if (platform === 'win32') {
    return {
      file: path.join(assetDir, darkSystemUi ? 'trayForDarkTaskbar.ico' : 'trayForLightTaskbar.ico'),
      template: false,
    }
  }
  // macOS: the template image, recoloured by the system. Linux trays vary too much to pick for;
  // the black glyph is the closest to a conventional monochrome status icon.
  return { file: path.join(assetDir, 'trayTemplate.png'), template: platform === 'darwin' }
}
