import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { inspectLauncherEntry, launcherPaths, renderLauncherEntry, shouldOfferLauncher } from './appImageLauncher'
import {
  autostartDir, inspectAutostartEntry, LAUNCHED_AT_LOGIN_ARG, launchCommand, LinuxAutostart, renderAutostartEntry,
  type AutostartFs,
} from './autostart'
import { closeQuestion, decideCloseAction, decideStartupWindow } from './closeBehavior'
import { execLine, parseDesktopEntry, parseExecLine, quoteExecArg } from './desktopEntry'
import { parsePrefs, PrefsStore } from './prefs'
import { sandboxRefusal } from './sandbox'
import { decideWhenDirIsFree, LOGIN_GRACE_MS, parseShowOutput, type UnitState } from './systemdUnit'
import { detectTrayHost, parseDbusSendReply, parseGdbusReply } from './trayHost'

suite('linux: desktop entry Exec quoting', () => {
  test('a plain path is left bare', () => {
    assert.strictEqual(execLine('/opt/TraceRoost/traceroost-desktop', ['--launched-at-login']), '/opt/TraceRoost/traceroost-desktop --launched-at-login')
  })

  test('spaces, quotes, $, backticks, backslashes and % survive a round trip', () => {
    for (const awkward of [
      '/home/ana maría/Downloads/TraceRoost (1).AppImage',
      '/home/u/odd "quoted" $HOME `cmd` back\\slash 100%.AppImage',
      '/home/日本語/アプリ/TraceRoost.AppImage',
      '/tmp/semi;colon&amp|pipe',
    ]) {
      const line = execLine(awkward, ['--launched-at-login'])
      assert.deepStrictEqual(parseExecLine(line), [awkward, '--launched-at-login'], line)
    }
  })

  test('% is always doubled, even unquoted, so it cannot read as a field code', () => {
    assert.strictEqual(quoteExecArg('50%'), '50%%')
    assert.strictEqual(quoteExecArg('%U'), '%%U')
  })

  test('quoting follows the spec: reserved characters force quotes, and the file doubles backslashes again', () => {
    assert.strictEqual(quoteExecArg('a b'), '"a b"')
    assert.strictEqual(quoteExecArg('a"b'), '"a\\"b"')
    // Exec-level escape of the backslash, then string-level doubling of both.
    assert.strictEqual(execLine('a\\b'), '"a\\\\\\\\b"')
    assert.strictEqual(quoteExecArg(''), '""')
  })

  test('an unterminated quote parses as nothing rather than a guess', () => {
    assert.strictEqual(parseExecLine('"/opt/unterminated'), undefined)
  })

  test('only the [Desktop Entry] group is read', () => {
    const fields = parseDesktopEntry('# c\n[Desktop Entry]\nName=A\nExec=x\n[Desktop Action new]\nExec=y\n')
    assert.strictEqual(fields.get('Exec'), 'x')
    assert.strictEqual(fields.get('Name'), 'A')
  })
})

suite('linux: launch at login (XDG autostart)', () => {
  const deb = launchCommand({ execPath: '/opt/TraceRoost/traceroost-desktop', isPackaged: true, appPath: '/opt/TraceRoost/resources/app.asar', appImage: undefined })

  test('the command is $APPIMAGE from an AppImage, the executable from a .deb, electron + app dir in development', () => {
    assert.deepStrictEqual(deb, { program: '/opt/TraceRoost/traceroost-desktop', args: [] })
    assert.deepStrictEqual(
      launchCommand({ execPath: '/tmp/.mount_TraceRabc/traceroost-desktop', isPackaged: true, appPath: 'x', appImage: '/home/u/Apps/TraceRoost.AppImage' }),
      { program: '/home/u/Apps/TraceRoost.AppImage', args: [] },
    )
    assert.deepStrictEqual(
      launchCommand({ execPath: '/repo/desktop/node_modules/electron/dist/electron', isPackaged: false, appPath: '/repo/desktop', appImage: undefined }),
      { program: '/repo/desktop/node_modules/electron/dist/electron', args: ['/repo/desktop'] },
    )
  })

  test('the directory honours an absolute XDG_CONFIG_HOME and ignores a relative one', () => {
    assert.strictEqual(autostartDir({}, '/home/u'), '/home/u/.config/autostart')
    assert.strictEqual(autostartDir({ XDG_CONFIG_HOME: '/cfg' }, '/home/u'), '/cfg/autostart')
    assert.strictEqual(autostartDir({ XDG_CONFIG_HOME: 'rel' }, '/home/u'), '/home/u/.config/autostart')
  })

  test('the entry launches this app with the login marker, guarded by TryExec, and is marked as ours', () => {
    const text = renderAutostartEntry(deb)
    const fields = parseDesktopEntry(text)
    assert.deepStrictEqual(parseExecLine(fields.get('Exec') ?? ''), ['/opt/TraceRoost/traceroost-desktop', LAUNCHED_AT_LOGIN_ARG])
    assert.strictEqual(fields.get('TryExec'), '/opt/TraceRoost/traceroost-desktop')
    assert.strictEqual(fields.get('X-TraceRoost-Managed'), 'true')
    assert.strictEqual(fields.get('Type'), 'Application')
    // It starts the app, never a collector: nothing in it names the CLI or the systemd unit.
    assert.doesNotMatch(text, /traceroost service|systemctl|standalone\/server/)
  })

  test('an entry pointing at a moved AppImage is stale; a hand-written or desktop-disabled one is left alone', () => {
    const now = { program: '/home/u/Apps/TraceRoost.AppImage', args: [] }
    const before = renderAutostartEntry({ program: '/home/u/Downloads/TraceRoost.AppImage', args: [] })
    assert.deepStrictEqual(inspectAutostartEntry(before, now), { kind: 'stale', program: '/home/u/Downloads/TraceRoost.AppImage' })
    assert.deepStrictEqual(inspectAutostartEntry(renderAutostartEntry(now), now), { kind: 'current' })
    assert.deepStrictEqual(inspectAutostartEntry('[Desktop Entry]\nExec=traceroost-desktop\n', now), { kind: 'foreign' })
    assert.deepStrictEqual(inspectAutostartEntry(renderAutostartEntry(now) + 'Hidden=true\n', now), { kind: 'disabled' })
    assert.deepStrictEqual(inspectAutostartEntry(undefined, now), { kind: 'absent' })
  })

  test('enable, repair after a move, and disable — against a real directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-autostart-'))
    try {
      const realFs: AutostartFs = {
        readFile: p => { try { return fs.readFileSync(p, 'utf-8') } catch { return undefined } },
        writeFile: (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t) },
        remove: p => fs.rmSync(p, { force: true }),
      }
      const autostartPath = path.join(dir, 'autostart')
      const oldCopy = new LinuxAutostart(autostartPath, { program: '/old/TraceRoost.AppImage', args: [] }, realFs)
      assert.strictEqual(oldCopy.isEnabled(), false)
      assert.strictEqual(oldCopy.setEnabled(true).kind, 'current')

      const moved = new LinuxAutostart(autostartPath, { program: '/new place/TraceRoost.AppImage', args: [] }, realFs)
      assert.strictEqual(moved.isEnabled(), true, 'a stale entry still means the user chose "on"')
      assert.deepStrictEqual(moved.repair(), { repairedFrom: '/old/TraceRoost.AppImage' })
      assert.strictEqual(moved.state().kind, 'current')
      assert.strictEqual(moved.repair(), undefined, 'nothing to repair the second time')

      assert.strictEqual(moved.setEnabled(false).kind, 'absent')
      assert.ok(!fs.existsSync(moved.filePath))

      // Someone else's file under our name is never written over or removed.
      fs.writeFileSync(moved.filePath, '[Desktop Entry]\nExec=/usr/local/bin/my-wrapper\n')
      assert.strictEqual(moved.setEnabled(true).kind, 'foreign')
      assert.strictEqual(moved.setEnabled(false).kind, 'foreign')
      assert.match(fs.readFileSync(moved.filePath, 'utf-8'), /my-wrapper/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('linux: the systemd user unit', () => {
  const unit = (over: Partial<UnitState> = {}): UnitState => ({ load: 'loaded', unitFile: 'enabled', active: 'inactive', ...over })

  test('parses systemctl show output, and refuses output without the fields', () => {
    assert.deepStrictEqual(parseShowOutput('LoadState=loaded\nUnitFileState=enabled\nActiveState=activating\n'), unit({ active: 'activating' }))
    assert.deepStrictEqual(parseShowOutput('LoadState=not-found\nUnitFileState=\nActiveState=inactive\n'), { load: 'not-found', unitFile: '', active: 'inactive' })
    assert.strictEqual(parseShowOutput('Failed to connect to bus'), undefined)
  })

  test('no unit, or no systemd, means the app owns', () => {
    assert.strictEqual(decideWhenDirIsFree(undefined, { launchedAtLogin: true, sinceStartMs: 0 }).action, 'own')
    assert.strictEqual(decideWhenDirIsFree(unit({ load: 'not-found', unitFile: '' }), { launchedAtLogin: true, sinceStartMs: 0 }).action, 'own')
  })

  test('a starting service is waited for, whoever launched the app', () => {
    for (const launchedAtLogin of [true, false]) {
      assert.strictEqual(decideWhenDirIsFree(unit({ active: 'activating' }), { launchedAtLogin, sinceStartMs: 5 * 60_000 }).action, 'wait')
    }
  })

  test('at login, an enabled service gets a grace period to start before the app takes the dir', () => {
    assert.strictEqual(decideWhenDirIsFree(unit(), { launchedAtLogin: true, sinceStartMs: 1_000 }).action, 'wait')
    const late = decideWhenDirIsFree(unit(), { launchedAtLogin: true, sinceStartMs: LOGIN_GRACE_MS + 1 })
    assert.strictEqual(late.action, 'own')
    assert.match(late.reason, /did not start/)
  })

  test('opened by hand with the service stopped: the documented handoff, so the app owns', () => {
    const d = decideWhenDirIsFree(unit(), { launchedAtLogin: false, sinceStartMs: 0 })
    assert.strictEqual(d.action, 'own')
    assert.match(d.reason, /stopped/)
  })

  test('a failed or disabled service does not hold the app up', () => {
    assert.strictEqual(decideWhenDirIsFree(unit({ active: 'failed' }), { launchedAtLogin: true, sinceStartMs: 0 }).action, 'own')
    assert.strictEqual(decideWhenDirIsFree(unit({ unitFile: 'disabled' }), { launchedAtLogin: true, sinceStartMs: 0 }).action, 'own')
  })

  test('an active service that never takes the lock is waited for only so long', () => {
    assert.strictEqual(decideWhenDirIsFree(unit({ active: 'active' }), { launchedAtLogin: false, sinceStartMs: 0 }).action, 'wait')
    assert.strictEqual(decideWhenDirIsFree(unit({ active: 'active' }), { launchedAtLogin: false, sinceStartMs: LOGIN_GRACE_MS }).action, 'own')
  })
})

suite('linux: tray host detection', () => {
  test('parses both tools\' replies', () => {
    assert.strictEqual(parseDbusSendReply('   boolean true\n'), true)
    assert.strictEqual(parseDbusSendReply('   boolean false\n'), false)
    assert.strictEqual(parseDbusSendReply('Error org.freedesktop.DBus.Error.ServiceUnknown'), undefined)
    assert.strictEqual(parseGdbusReply('(true,)\n'), true)
    assert.strictEqual(parseGdbusReply('(false,)\n'), false)
    assert.strictEqual(parseGdbusReply('Error: GDBus.Error'), undefined)
  })

  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }

  test('a watcher on the bus means a tray', async () => {
    const r = await detectTrayHost(env, async file => ({ ok: file === 'dbus-send', stdout: '   boolean true' }))
    assert.deepStrictEqual(r, { available: true, via: 'dbus-send' })
  })

  test('falls back to gdbus when dbus-send is missing', async () => {
    const r = await detectTrayHost(env, async file => file === 'gdbus' ? { ok: true, stdout: '(true,)' } : { ok: false, stdout: '' })
    assert.deepStrictEqual(r, { available: true, via: 'gdbus' })
  })

  test('stock GNOME (no watcher) means no tray', async () => {
    const r = await detectTrayHost(env, async () => ({ ok: true, stdout: '   boolean false' }))
    assert.strictEqual(r.available, false)
  })

  test('when nothing can answer, the answer is no — never an invisible tray', async () => {
    const r = await detectTrayHost(env, async () => ({ ok: false, stdout: '' }))
    assert.strictEqual(r.available, false)
    const noBus = await detectTrayHost({}, async () => { throw new Error('must not be called') })
    assert.strictEqual(noBus.available, false)
  })
})

suite('linux: closing the window', () => {
  test('macOS, and Linux with a tray, close to the tray', () => {
    assert.strictEqual(decideCloseAction({ platform: 'darwin', trayAvailable: true, owningCollection: true }), 'hide-to-tray')
    assert.strictEqual(decideCloseAction({ platform: 'linux', trayAvailable: true, owningCollection: true }), 'hide-to-tray')
  })

  test('Linux with no tray never hides the window away', () => {
    assert.strictEqual(decideCloseAction({ platform: 'linux', trayAvailable: false, owningCollection: true }), 'ask')
    assert.strictEqual(decideCloseAction({ platform: 'linux', trayAvailable: false, owningCollection: false }), 'quit')
  })

  test('the question says that quitting stops collection, and offers the alternatives', () => {
    const q = closeQuestion('GNOME')
    assert.match(q.message, /stop collecting/)
    assert.match(q.detail, /GNOME/)
    assert.match(q.detail, /stops recording/)
    assert.match(q.detail, /AppIndicator/)
    assert.strictEqual(q.buttons.length, 3)
  })

  test('a login launch shows nothing where a tray holds the app, and a minimised window where none does', () => {
    assert.strictEqual(decideStartupWindow({ platform: 'linux', launchedAtLogin: false, trayAvailable: false }), 'show')
    assert.strictEqual(decideStartupWindow({ platform: 'linux', launchedAtLogin: true, trayAvailable: true }), 'none')
    assert.strictEqual(decideStartupWindow({ platform: 'linux', launchedAtLogin: true, trayAvailable: false }), 'minimized')
    assert.strictEqual(decideStartupWindow({ platform: 'darwin', launchedAtLogin: true, trayAvailable: true }), 'none')
  })
})

suite('linux: sandbox', () => {
  test('a sandboxed start is never refused', () => {
    assert.strictEqual(sandboxRefusal({ platform: 'linux', noSandbox: false, appImage: '/a.AppImage' }), undefined)
  })

  test('an AppImage launched with --no-sandbox refuses, and says what to do', () => {
    const r = sandboxRefusal({ platform: 'linux', noSandbox: true, appImage: '/home/u/TraceRoost.AppImage' })
    assert.ok(r)
    assert.match(r.message, /install the TraceRoost \.deb/i)
    assert.match(r.message, /AppArmor profile/)
    assert.match(r.message, /not recommended/)
  })

  test('--no-sandbox from anywhere else refuses too', () => {
    assert.ok(sandboxRefusal({ platform: 'linux', noSandbox: true, appImage: undefined }))
    assert.ok(sandboxRefusal({ platform: 'darwin', noSandbox: true, appImage: undefined }))
  })
})

suite('linux: prefs', () => {
  test('unknown or malformed values are dropped', () => {
    assert.deepStrictEqual(parsePrefs('{"closeWithoutTray":"minimize","appImageLauncher":"maybe","x":1}'), { closeWithoutTray: 'minimize' })
    assert.deepStrictEqual(parsePrefs('not json'), {})
    assert.deepStrictEqual(parsePrefs(undefined), {})
  })

  test('round-trips through a real file, owner-only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-prefs-'))
    try {
      const store = new PrefsStore(path.join(dir, 'nested'))
      store.update({ appImageLauncher: 'declined' })
      store.update({ closeWithoutTray: 'quit' })
      assert.deepStrictEqual(store.read(), { appImageLauncher: 'declined', closeWithoutTray: 'quit' })
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(store.filePath).mode & 0o777, 0o600)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

suite('linux: AppImage launcher entry', () => {
  test('paths follow XDG_DATA_HOME', () => {
    assert.deepStrictEqual(launcherPaths({}, '/home/u'), {
      entry: '/home/u/.local/share/applications/traceroost-appimage.desktop',
      icon: '/home/u/.local/share/icons/hicolor/512x512/apps/traceroost-appimage.png',
    })
    assert.strictEqual(launcherPaths({ XDG_DATA_HOME: '/d' }, '/home/u').entry, '/d/applications/traceroost-appimage.desktop')
  })

  test('the entry launches the AppImage itself, and goes stale when it moves', () => {
    const text = renderLauncherEntry('/home/u/Apps/Trace Roost.AppImage')
    assert.strictEqual(inspectLauncherEntry(text, '/home/u/Apps/Trace Roost.AppImage'), 'current')
    assert.strictEqual(inspectLauncherEntry(text, '/home/u/Elsewhere/TraceRoost.AppImage'), 'stale')
    assert.strictEqual(inspectLauncherEntry('[Desktop Entry]\nExec=x\n', 'x'), 'foreign')
    assert.doesNotMatch(text, /--no-sandbox/)
  })

  test('offered once, only from an AppImage, and never over an existing entry', () => {
    assert.strictEqual(shouldOfferLauncher({ appImage: '/a.AppImage', answered: undefined, state: 'absent' }), true)
    assert.strictEqual(shouldOfferLauncher({ appImage: undefined, answered: undefined, state: 'absent' }), false)
    assert.strictEqual(shouldOfferLauncher({ appImage: '/a.AppImage', answered: 'declined', state: 'absent' }), false)
    assert.strictEqual(shouldOfferLauncher({ appImage: '/a.AppImage', answered: undefined, state: 'stale' }), false)
  })
})
