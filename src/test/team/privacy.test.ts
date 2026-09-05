import * as assert from 'assert'
import { SENT, NEVER_SENT } from '../../team/privacy'

// This test pins the exact wording of the payload promise. The same list is rendered by the
// Team panel, printed by `--explain-payload`, shown on the OAuth consent screen (alsaas
// src/lib/privacy.ts) and carried in the invite email. When the repos are reconciled this
// becomes a cross-repo fixture check (OPEN-QUESTIONS CC-1). If you are changing this text,
// change it in alsaas in the same PR.
suite('team/privacy', () => {
  test('SENT is the agreed list, verbatim', () => {
    assert.deepStrictEqual([...SENT], [
      'Session, turn and tool-call counts',
      'Token counts and cost',
      'Model and agent names (Claude, Copilot, Codex, …)',
      'Duration and timestamps',
      'Hashed commit ids and hashed file ids — one-way, keyed from your own clone',
      'Line counts (added, removed, AI-authored, surviving)',
      'Loop- and error-signal categories (an enum and a severity, never a message)',
    ])
  })

  test('NEVER_SENT is the agreed list, verbatim', () => {
    assert.deepStrictEqual([...NEVER_SENT], [
      'Prompts and completions',
      'Diffs and file contents',
      'File names, paths and repository names',
      'Branch names and commit messages',
      'Raw commit SHAs',
    ])
  })

  test('no SENT item names a free-text artefact', () => {
    const banned = /\b(prompt|completion|diff|content|message|filename|path)\b/i
    for (const item of SENT) {
      // "commit messages" only appears in NEVER_SENT; SENT may say "never a message" which is fine
      if (item.includes('never a message')) continue
      assert.ok(!banned.test(item), `SENT item looks like free text: "${item}"`)
    }
  })
})
