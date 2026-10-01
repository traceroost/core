import * as assert from 'assert'
import * as path from 'path'
import { isStrictlyInside } from './pathGuard'

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
