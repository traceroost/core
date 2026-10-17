import * as assert from 'assert'
import { decideNavigation, decideWindowOpen, isAllowedExternalHost } from './navigation'

const ORIGIN = 'http://127.0.0.1:3000'

suite('navigation', () => {
  test('the dashboard origin loads in the window', () => {
    assert.strictEqual(decideNavigation(`${ORIGIN}/`, ORIGIN).action, 'allow-in-window')
    assert.strictEqual(decideNavigation(`${ORIGIN}/events`, ORIGIN).action, 'allow-in-window')
    assert.strictEqual(decideNavigation(`${ORIGIN}/dashboard.js?v=2`, ORIGIN).action, 'allow-in-window')
  })

  test('another port on loopback is a different origin, and not the dashboard', () => {
    const decision = decideNavigation('http://127.0.0.1:3001/', ORIGIN)
    assert.strictEqual(decision.action, 'block')
  })

  test('allowlisted vendor docs are handed to the system browser, never loaded in-window', () => {
    for (const url of [
      'https://github.com/traceroost/core',
      'https://docs.github.com/en/actions',
      'https://platform.claude.com/docs',
      'https://traceroost.com/suggest',
      'https://opencode.ai/docs',
    ]) {
      assert.strictEqual(decideNavigation(url, ORIGIN).action, 'open-externally', url)
    }
  })

  test('subdomains of an allowed host are allowed, lookalike suffixes are not', () => {
    assert.ok(isAllowedExternalHost('docs.traceroost.com'))
    assert.ok(isAllowedExternalHost('GITHUB.COM'))
    assert.ok(!isAllowedExternalHost('traceroost.com.evil.test'))
    assert.ok(!isAllowedExternalHost('nottraceroost.com'))
    assert.ok(!isAllowedExternalHost('evil.test'))
  })

  test('an arbitrary https URL is dropped — an allowlist, not "https is fine"', () => {
    const decision = decideNavigation('https://evil.test/collect?data=secret', ORIGIN)
    assert.strictEqual(decision.action, 'block')
  })

  test('http to an external host is dropped even when the host is allowlisted', () => {
    assert.strictEqual(decideNavigation('http://github.com/x', ORIGIN).action, 'block')
  })

  test('every non-http scheme is dropped — file: most of all', () => {
    for (const url of [
      'file:///Users/someone/.ssh/id_rsa',
      'javascript:alert(1)',
      'vscode://traceroost/trace/1',
      'data:text/html,<script>1</script>',
      'about:blank',
      'ftp://host.test/x',
    ]) {
      const decision = decideNavigation(url, ORIGIN)
      assert.strictEqual(decision.action, 'block', url)
    }
  })

  test('something that is not a URL at all is dropped', () => {
    assert.strictEqual(decideNavigation('', ORIGIN).action, 'block')
    assert.strictEqual(decideNavigation('/relative/path', ORIGIN).action, 'block')
  })

  test('nothing opens a second window, not even the dashboard itself', () => {
    const decision = decideWindowOpen(`${ORIGIN}/events`, ORIGIN)
    assert.strictEqual(decision.action, 'block')
    assert.match(decision.reason, /does not open extra windows/)
  })

  test('a popup to an allowed external host still goes to the system browser', () => {
    assert.strictEqual(decideWindowOpen('https://github.com/traceroost/core', ORIGIN).action, 'open-externally')
  })
})
