import * as assert from 'assert'
import { extractUserRequest, isTaskNotificationOnly, summarizeTaskNotification } from '../summarizers/helpers'

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
