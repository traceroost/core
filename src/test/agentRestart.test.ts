import * as assert from 'assert'
import { AgentRestartTracker, type AgentRestartNeeded } from '../agentRestart'

suite('AgentRestartTracker', () => {
  function tracker() {
    const changes: Array<AgentRestartNeeded | null> = []
    return { t: new AgentRestartTracker(s => changes.push(s)), changes }
  }

  test('lists only the agents whose settings a setup run changed', () => {
    const { t, changes } = tracker()
    t.noteSetup(4319, { claudeCode: { changed: true }, codex: { changed: false }, copilot: { changed: true } })
    assert.deepStrictEqual(t.state(), { port: 4319, agents: ['claudeCode', 'copilot'] })
    assert.strictEqual(changes.length, 1)
  })

  test('a run that changed nothing is silent and keeps what is already listed', () => {
    const { t, changes } = tracker()
    t.noteSetup(4318, { claudeCode: { changed: false }, codex: { changed: false } })
    assert.strictEqual(t.state(), null)
    assert.strictEqual(changes.length, 0)
    t.noteSetup(4318, { codex: { changed: true } })
    t.noteSetup(4318, { claudeCode: { changed: false }, codex: { changed: false } })
    assert.deepStrictEqual(t.state(), { port: 4318, agents: ['codex'] })
  })

  test('each agent clears when the collector hears from it', () => {
    const { t, changes } = tracker()
    t.noteSetup(4319, { claudeCode: { changed: true }, codex: { changed: true }, copilot: { changed: true } })
    t.noteOtlp('codex')
    assert.deepStrictEqual(t.state(), { port: 4319, agents: ['claudeCode', 'copilot'] })
    t.noteOtlp('codex') // already cleared: no second notification
    t.noteOtlp('claude')
    t.noteOtlp('copilot_vscode')
    assert.strictEqual(t.state(), null)
    assert.deepStrictEqual(changes.map(c => c?.agents.length ?? 0), [3, 2, 1, 0])
  })

  test('the Copilot CLI and agents setup does not configure clear nothing', () => {
    const { t } = tracker()
    t.noteSetup(4318, { copilot: { changed: true } })
    t.noteOtlp('copilot')
    t.noteOtlp('cursor')
    assert.deepStrictEqual(t.state(), { port: 4318, agents: ['copilot'] })
  })

  test('dismiss clears everything, once', () => {
    const { t, changes } = tracker()
    t.dismiss()
    assert.strictEqual(changes.length, 0)
    t.noteSetup(4318, { claudeCode: { changed: true } })
    t.dismiss()
    assert.strictEqual(t.state(), null)
    assert.deepStrictEqual(changes, [{ port: 4318, agents: ['claudeCode'] }, null])
  })

  test('a move to another port replaces the list rather than adding to it', () => {
    const { t } = tracker()
    t.noteSetup(4318, { claudeCode: { changed: true }, codex: { changed: true } })
    t.noteSetup(4320, { codex: { changed: true } })
    assert.deepStrictEqual(t.state(), { port: 4320, agents: ['codex'] })
  })
})
