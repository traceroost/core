// tests/e2e/lib.mjs's providerRefusal: the agent capture names a billing or key refusal instead of
// diffing the one synthetic error record the agent writes, which reads as a format change.
import * as assert from 'assert'
import * as path from 'path'
import { pathToFileURL } from 'url'

// A real dynamic import (not compiled to require): the e2e helpers are ES modules.
const importEsm = new Function('p', 'return import(p)') as (p: string) => Promise<Record<string, unknown>>
const ROOT = path.resolve(__dirname, '..', '..', '..')

type Refusal = (stdout?: string, stderr?: string) => string | undefined

suite('e2e providerRefusal', () => {
  let providerRefusal: Refusal
  suiteSetup(async () => {
    const lib = await importEsm(pathToFileURL(path.join(ROOT, 'tests', 'e2e', 'lib.mjs')).href)
    providerRefusal = lib.providerRefusal as Refusal
  })

  test("reads Claude Code's JSON result (agent capture run 45039668483)", () => {
    const stdout = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true, duration_api_ms: 0, stop_reason: 'stop_sequence',
      result: 'Credit balance is too low', total_cost_usd: 0,
    })
    assert.strictEqual(providerRefusal(stdout, ''), 'Credit balance is too low')
  })

  test("reads OpenCode's coloured error line (same run)", () => {
    const stdout = '\x1b[0m\n> build · claude-haiku-4-5\n\x1b[0m\n\x1b[91m\x1b[1mError: \x1b[0mYour credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.\n'
    assert.strictEqual(providerRefusal(stdout, ''),
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.')
  })

  test('recognises a rejected key and an exhausted OpenAI quota', () => {
    assert.match(providerRefusal('', 'Error: Invalid API key · Fix external API key') ?? '', /Invalid API key/)
    assert.match(providerRefusal('', 'stream error: 429 insufficient_quota: You exceeded your current quota') ?? '', /insufficient_quota/)
  })

  test('leaves every other failure alone, so a real break is not explained away', () => {
    assert.strictEqual(providerRefusal('', 'TypeError: Cannot read properties of undefined'), undefined)
    assert.strictEqual(providerRefusal(JSON.stringify({ type: 'result', is_error: true, result: 'Reached max turns (6)' }), ''), undefined)
    assert.strictEqual(providerRefusal(JSON.stringify({ type: 'result', is_error: false, result: 'Created hello.txt' }), ''), undefined)
    assert.strictEqual(providerRefusal('', ''), undefined)
  })
})
