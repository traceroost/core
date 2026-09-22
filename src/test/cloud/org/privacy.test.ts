import * as assert from 'assert'
import { SENT, NEVER_SENT } from '../../../cloud/org/privacy'

// This test pins the exact wording of the payload promise. The same list is rendered by the
// Org panel, printed by `--explain-payload`, shown on the OAuth consent screen (cloud
// src/lib/privacy.ts) and carried in the invite email. When the repos are reconciled this
// becomes a cross-repo fixture check (OPEN-QUESTIONS CC-1). If you are changing this text,
// change it in cloud in the same PR.
suite('org/privacy', () => {
  test('SENT is the agreed list, verbatim', () => {
    assert.deepStrictEqual([...SENT], [
      'Usage counts — traces, turns, tool calls, tokens, cost',
      'Model and agent names, with timestamps',
      'Hashed commit and file ids — one-way, from your own clone',
      'Line counts: added, removed, AI-authored, surviving',
      'Loop and error categories (never a message)',
    ])
  })

  test('NEVER_SENT is the agreed list, verbatim', () => {
    assert.deepStrictEqual([...NEVER_SENT], [
      'Prompts, completions, diffs and file contents',
      'File paths, repository and branch names',
      'Commit messages and raw commit SHAs',
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
