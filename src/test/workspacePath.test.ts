import * as assert from 'assert'
import { isSameOrInsideWorkspace } from '../workspacePath'

suite('workspacePath — isSameOrInsideWorkspace', () => {
  test('the workspace itself and directories inside it match; a sibling sharing the prefix does not', () => {
    assert.strictEqual(isSameOrInsideWorkspace('/repo', '/repo'), true)
    assert.strictEqual(isSameOrInsideWorkspace('/repo/', '/repo'), true)
    assert.strictEqual(isSameOrInsideWorkspace('/repo/packages/a', '/repo'), true)
    assert.strictEqual(isSameOrInsideWorkspace('/repo-old', '/repo'), false)
    assert.strictEqual(isSameOrInsideWorkspace('/repository/x', '/repo'), false)
    assert.strictEqual(isSameOrInsideWorkspace('C:\\code\\repo\\src', 'C:\\code\\repo'), true)
    assert.strictEqual(isSameOrInsideWorkspace('C:\\code\\repo2', 'C:\\code\\repo'), false)
    assert.strictEqual(isSameOrInsideWorkspace('', '/repo'), false)
    assert.strictEqual(isSameOrInsideWorkspace(undefined, '/repo'), false)
  })
})
