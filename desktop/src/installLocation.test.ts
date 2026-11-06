import * as assert from 'assert'
import { bundleOf, launchLocation, pidsRunningBundle, shouldOfferMove, type MoveOfferInput } from './installLocation'

const fromDmg: MoveOfferInput = {
  platform: 'darwin',
  isPackaged: true,
  inApplicationsFolder: false,
  bundlePath: '/Volumes/TraceRoost 0.21.0-arm64/TraceRoost.app',
  declined: false,
  launchedAtLogin: false,
}

suite('installLocation — moving to Applications on a double-click from the DMG', () => {
  test('where the bundle runs from', () => {
    assert.strictEqual(launchLocation('/Volumes/TraceRoost 0.21.0-arm64/TraceRoost.app'), 'disk-image')
    assert.strictEqual(launchLocation('/private/var/folders/gd/x/T/AppTranslocation/0A1B-2C3D/d/TraceRoost.app'), 'translocated')
    assert.strictEqual(launchLocation('/Applications/TraceRoost.app'), 'elsewhere')
    assert.strictEqual(launchLocation('/Users/me/src/core/desktop/dist/mac-arm64/TraceRoost.app'), 'elsewhere')
  })

  test('offered for a packaged macOS app opened from a disk image or translocated', () => {
    assert.strictEqual(shouldOfferMove(fromDmg), true)
    assert.strictEqual(shouldOfferMove({ ...fromDmg, bundlePath: '/private/var/folders/gd/x/T/AppTranslocation/0A1B/d/TraceRoost.app' }), true)
  })

  test('not offered anywhere else, nor once declined for good', () => {
    assert.strictEqual(shouldOfferMove({ ...fromDmg, inApplicationsFolder: true }), false)
    assert.strictEqual(shouldOfferMove({ ...fromDmg, declined: true }), false)
    assert.strictEqual(shouldOfferMove({ ...fromDmg, launchedAtLogin: true }), false)
    assert.strictEqual(shouldOfferMove({ ...fromDmg, isPackaged: false }), false)
    assert.strictEqual(shouldOfferMove({ ...fromDmg, platform: 'linux' }), false)
    // The repo's dist/ — development, the smoke test, CI — and a copy the user put somewhere on purpose.
    assert.strictEqual(shouldOfferMove({ ...fromDmg, bundlePath: '/Users/me/src/core/desktop/dist/mac-arm64/TraceRoost.app' }), false)
    assert.strictEqual(shouldOfferMove({ ...fromDmg, bundlePath: '/Users/me/Tools/TraceRoost.app' }), false)
  })

  test('the bundle of the main executable', () => {
    assert.strictEqual(bundleOf('/Volumes/TraceRoost/TraceRoost.app/Contents/MacOS/TraceRoost'), '/Volumes/TraceRoost/TraceRoost.app')
    assert.strictEqual(bundleOf('/opt/electron/electron'), '/opt/electron/electron')
  })

  test('running copies: the top-level app process at that path, not its collector or helpers', () => {
    const ps = [
      '  101     1 /Applications/TraceRoost.app/Contents/MacOS/TraceRoost',
      '  102   101 /Applications/TraceRoost.app/Contents/Frameworks/TraceRoost Helper.app/Contents/MacOS/TraceRoost Helper --type=gpu-process',
      // The collector runs on the app's own executable, as ELECTRON_RUN_AS_NODE.
      '  103   101 /Applications/TraceRoost.app/Contents/MacOS/TraceRoost /Applications/TraceRoost.app/Contents/Resources/collector/standalone/server.js',
      '  104     1 /Volumes/TraceRoost/TraceRoost.app/Contents/MacOS/TraceRoost',
      '  105     1 /Applications/TraceRoost Beta.app/Contents/MacOS/TraceRoost',
      ' 1066     1 /Applications/TraceRoost.app/Contents/MacOS/TraceRoost --launched-at-login',
    ].join('\n')
    assert.deepStrictEqual(pidsRunningBundle(ps, '/Applications/TraceRoost.app'), [101, 1066])
    assert.deepStrictEqual(pidsRunningBundle(ps, '/Users/me/Applications/TraceRoost.app'), [])
  })
})
