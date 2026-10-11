import * as assert from 'assert'
import * as path from 'path'
import { isStrictlyInside, resolveStaticFile } from './pathGuard'

suite('isStrictlyInside', () => {
  const ws = path.resolve('/work/repo')

  test('accepts instruction files inside the workspace', () => {
    assert.strictEqual(isStrictlyInside(ws, 'CLAUDE.md'), true)
    assert.strictEqual(isStrictlyInside(ws, '.github/copilot-instructions.md'), true)
    assert.strictEqual(isStrictlyInside(ws, path.join(ws, 'AGENTS.md')), true)
    assert.strictEqual(isStrictlyInside(ws, '..notes.md'), true)
  })

  test('rejects traversal, absolute paths elsewhere, and the workspace itself', () => {
    assert.strictEqual(isStrictlyInside(ws, '../../.bashrc'), false)
    assert.strictEqual(isStrictlyInside(ws, 'sub/../../outside.md'), false)
    assert.strictEqual(isStrictlyInside(ws, path.resolve('/etc/passwd')), false)
    assert.strictEqual(isStrictlyInside(ws, `${ws}-sibling/CLAUDE.md`), false)
    assert.strictEqual(isStrictlyInside(ws, ''), false)
    assert.strictEqual(isStrictlyInside(ws, '.'), false)
  })
})

suite('resolveStaticFile', () => {
  const media = path.resolve('/opt/traceroost/media')

  test('serves files under the root', () => {
    assert.strictEqual(resolveStaticFile(media, '/dist/webview.js'), path.join(media, 'dist', 'webview.js'))
    assert.strictEqual(resolveStaticFile(media, '/icon.svg'), path.join(media, 'icon.svg'))
    // Normalised traversal that stays inside is still inside.
    assert.strictEqual(resolveStaticFile(media, '/dist/../icon.svg'), path.join(media, 'icon.svg'))
  })

  test('refuses a sibling folder that shares the root as a prefix', () => {
    // path.join(media, '/../media-private/secret.js') === '/opt/traceroost/media-private/secret.js',
    // which `startsWith(media)` accepted.
    assert.ok(path.join(media, '/../media-private/secret.js').startsWith(media), 'precondition: the old check passed this')
    assert.strictEqual(resolveStaticFile(media, '/../media-private/secret.js'), null)
  })

  test('refuses traversal out of the root and the root itself', () => {
    assert.strictEqual(resolveStaticFile(media, '/../../../etc/passwd.js'), null)
    assert.strictEqual(resolveStaticFile(media, '/../package.json'), null)
    assert.strictEqual(resolveStaticFile(media, '/'), null)
    assert.strictEqual(resolveStaticFile(media, ''), null)
  })
})
