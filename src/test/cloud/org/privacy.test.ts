import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { SENT, NEVER_SENT, whoSeesWhat } from '../../../cloud/org/privacy'

// This test pins the exact wording of the payload promise. The same list is rendered by the
// Org panel, printed by `--explain-payload`, shown on the OAuth consent screen (cloud
// src/lib/privacy.ts) and carried in the invite email. When the repos are reconciled this
// becomes a cross-repo fixture check (OPEN-QUESTIONS CC-1). If you are changing this text,
// change it in cloud in the same PR.
suite('org/privacy', () => {
  test('SENT is the agreed list, verbatim', () => {
    assert.deepStrictEqual([...SENT], [
      'Usage counts — traces, turns, tool calls, tokens, files changed, lines added and removed',
      'Model, agent and programming-language names, with timestamps',
      'Hashed repository, branch and file ids — one-way, from your own clone',
      'Instruction-file line counts and how often sessions read each file',
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

  test('whoSeesWhat is the consent screen\'s wording (cloud src/lib/privacy.ts), verbatim', () => {
    assert.strictEqual(
      whoSeesWhat(true, 'Acme'),
      'Acme has per-developer numbers turned on — an admin, or a developer individually granted org visibility, sees your individual figures. You will see a marker saying so.',
    )
    assert.strictEqual(
      whoSeesWhat(false, 'Acme'),
      'Admins of Acme see org totals only. Your individual numbers stay yours unless the whole org turns that on.',
    )
  })

  test('the Org panel webview renders the same lists (it cannot import this module)', () => {
    // out/test/test/cloud/org → repo root is five levels up from the compiled test.
    const candidates = [
      path.join(__dirname, '..', '..', '..', '..', '..', 'media', 'src', 'cloud', 'panels', 'OrgPanel.tsx'),
      path.join(process.cwd(), 'media', 'src', 'cloud', 'panels', 'OrgPanel.tsx'),
    ]
    const file = candidates.find(p => fs.existsSync(p))
    assert.ok(file, 'OrgPanel.tsx not found')
    const text = fs.readFileSync(file!, 'utf-8')
    for (const line of [...SENT, ...NEVER_SENT]) assert.ok(text.includes(`'${line}'`), `OrgPanel.tsx is missing: ${line}`)
    for (const line of [whoSeesWhat(true, '${orgName}'), whoSeesWhat(false, '${orgName}')]) {
      assert.ok(text.includes(line), `OrgPanel.tsx whoSeesWhat drifted: ${line}`)
    }
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
