import * as assert from 'assert'
import { LAUNCHED_AT_LOGIN_ARG, launchCommand } from './autostart'
import { isQuitRequest, QUIT_ARG, trayIconFile, windowsLoginItem } from './windows'

suite('windows — the Windows-specific decisions', () => {
  test('--quit is recognised anywhere in argv (the second instance\'s argv carries the exe first)', () => {
    assert.strictEqual(QUIT_ARG, '--quit')
    assert.strictEqual(isQuitRequest(['C:\\Program Files\\TraceRoost\\traceroost-desktop.exe', '--quit']), true)
    assert.strictEqual(isQuitRequest(['traceroost-desktop.exe', '--allow-file-access-from-files', '--quit']), true)
    assert.strictEqual(isQuitRequest(['traceroost-desktop.exe']), false)
    assert.strictEqual(isQuitRequest(['traceroost-desktop.exe', LAUNCHED_AT_LOGIN_ARG]), false)
    assert.strictEqual(isQuitRequest(['traceroost-desktop.exe', '--quitter']), false)
  })

  test('the Run-key entry is this copy\'s executable with the login marker', () => {
    const exe = 'C:\\Users\\dev\\AppData\\Local\\Programs\\TraceRoost\\traceroost-desktop.exe'
    const packaged = launchCommand({ execPath: exe, isPackaged: true, appPath: 'ignored', appImage: undefined })
    assert.deepStrictEqual(windowsLoginItem(packaged), { path: exe, args: [LAUNCHED_AT_LOGIN_ARG] })
    // In development: Electron plus the app directory, then the marker.
    const dev = launchCommand({ execPath: 'C:\\repo\\desktop\\node_modules\\electron\\dist\\electron.exe', isPackaged: false, appPath: 'C:\\repo\\desktop', appImage: undefined })
    assert.deepStrictEqual(windowsLoginItem(dev).args, ['C:\\repo\\desktop', LAUNCHED_AT_LOGIN_ARG])
  })

  test('each platform reads its own tray icon', () => {
    assert.strictEqual(trayIconFile('darwin'), 'trayTemplate.png')
    assert.strictEqual(trayIconFile('linux'), 'trayLinux.png')
    assert.strictEqual(trayIconFile('win32'), 'trayWindows.ico')
  })
})
