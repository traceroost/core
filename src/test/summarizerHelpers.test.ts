import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { extractUserRequest, isTaskNotificationOnly, summarizeTaskNotification, findProjectRoot, commonPathPrefix } from '../summarizers/helpers'

suite('findProjectRoot', () => {
  let tmpRoot: string

  setup(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-findProjectRoot-'))
  })

  teardown(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('returns the directory containing .git', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'))
    const deep = path.join(tmpRoot, 'src', 'tabs')
    fs.mkdirSync(deep, { recursive: true })
    assert.strictEqual(findProjectRoot(deep), tmpRoot)
  })

  test('returns the directory containing package.json', () => {
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), '{}')
    assert.strictEqual(findProjectRoot(tmpRoot), tmpRoot)
  })

  test('passes through non-absolute or empty input unchanged', () => {
    assert.strictEqual(findProjectRoot(''), '')
    assert.strictEqual(findProjectRoot('relative/path'), 'relative/path')
  })

  test('returns startDir unchanged when no marker is found but it sits well below the home directory', () => {
    const deep = path.join(tmpRoot, 'a', 'b', 'c')
    fs.mkdirSync(deep, { recursive: true })
    // tmpRoot has no .git/package.json anywhere up to '/', so the walk finds nothing — but
    // `deep` is far deeper than the fake home dir, so it's still trusted as a fallback.
    assert.strictEqual(findProjectRoot(deep, '/fake-home-unrelated'), deep)
  })

  test('reports no signal (empty string) when the walk collapses to exactly the home directory', () => {
    assert.strictEqual(findProjectRoot('/Users/rogerreed', '/Users/rogerreed'), '')
  })

  test('reports no signal when startDir is an ancestor of the home directory', () => {
    assert.strictEqual(findProjectRoot('/Users', '/Users/rogerreed'), '')
  })

  test('reports no signal when startDir is the filesystem root', () => {
    assert.strictEqual(findProjectRoot('/', '/Users/rogerreed'), '')
  })
})

suite('commonPathPrefix', () => {
  test('returns empty string for no paths', () => {
    assert.strictEqual(commonPathPrefix([]), '')
  })

  test('returns the shared directory ancestor of multiple absolute paths', () => {
    assert.strictEqual(
      commonPathPrefix(['/Users/rogerreed/proj/src/a.ts', '/Users/rogerreed/proj/src/b.ts']),
      '/Users/rogerreed/proj/src',
    )
  })

  test('collapses to a shallow prefix when paths diverge early', () => {
    assert.strictEqual(
      commonPathPrefix(['/Users/rogerreed/repo-a/x.ts', '/Users/rogerreed/repo-b/y.ts']),
      '/Users/rogerreed',
    )
  })
})

suite('summarizers/helpers — task notification handling', () => {
  const notification = `<task-notification>
<task-id>b23vr6t12</task-id>
<tool-use-id>toolu_012D7WrqUC6LroHZsTrb9svF</tool-use-id>
<output-file>/private/tmp/claude-501/tasks/b23vr6t12.output</output-file>
<status>completed</status>
<summary>Background compile finished with no errors.</summary>
</task-notification>`

  test('isTaskNotificationOnly is true for a bare notification block', () => {
    assert.strictEqual(isTaskNotificationOnly(notification), true)
  })

  test('isTaskNotificationOnly is false when real text sits alongside the block', () => {
    assert.strictEqual(isTaskNotificationOnly(`${notification}\n\nwhat now?`), false)
  })

  test('isTaskNotificationOnly is false for ordinary text', () => {
    assert.strictEqual(isTaskNotificationOnly('fix the bug in auth.ts'), false)
  })

  test('summarizeTaskNotification pulls the <summary> field', () => {
    assert.strictEqual(summarizeTaskNotification(notification), '[background task] Background compile finished with no errors.')
  })

  test('summarizeTaskNotification falls back when there is no <summary> field', () => {
    const noSummary = '<task-notification><task-id>x</task-id></task-notification>'
    assert.strictEqual(summarizeTaskNotification(noSummary), '[background task result]')
  })

  test('extractUserRequest returns the notification summary instead of raw XML', () => {
    assert.strictEqual(extractUserRequest(notification), '[background task] Background compile finished with no errors.')
  })
})
