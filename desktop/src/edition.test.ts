import * as assert from 'assert'
import * as path from 'path'

// desktop/scripts/edition.cjs is what stage-resources.mjs, third-party-notices.mjs,
// electron-builder.cjs and afterPack.cjs all read the desktop edition through; load the real file.
const { desktopEdition } = require(path.join(__dirname, '..', '..', '..', '..', 'desktop', 'scripts', 'edition.cjs')) as {
  desktopEdition: (env?: Record<string, string | undefined>) => 'core' | 'full'
}

suite('desktop edition — which collector the app ships', () => {
  test('unset or empty is core, so pull requests and local builds are unchanged', () => {
    assert.strictEqual(desktopEdition({}), 'core')
    assert.strictEqual(desktopEdition({ TRACEROOST_DESKTOP_EDITION: '' }), 'core')
    assert.strictEqual(desktopEdition({ TRACEROOST_DESKTOP_EDITION: ' ' }), 'core')
  })

  test('follows TRACEROOST_DESKTOP_EDITION when it names an edition', () => {
    assert.strictEqual(desktopEdition({ TRACEROOST_DESKTOP_EDITION: 'core' }), 'core')
    assert.strictEqual(desktopEdition({ TRACEROOST_DESKTOP_EDITION: 'full' }), 'full')
  })

  test('anything else fails the build rather than guessing', () => {
    assert.throws(() => desktopEdition({ TRACEROOST_DESKTOP_EDITION: 'Full' }), /expected core or full/)
    assert.throws(() => desktopEdition({ TRACEROOST_DESKTOP_EDITION: 'cloud' }), /expected core or full/)
  })
})
