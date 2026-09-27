import * as assert from 'assert'
import { shouldRedact, safeFilenamePart } from '../exportData'

suite('exportData', () => {
  suite('shouldRedact', () => {
    test('redacts OTel GenAI conversation and tool I/O attributes', () => {
      for (const key of [
        'gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions',
        'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
        'llm.input.messages', 'tool.arguments',
      ]) {
        assert.strictEqual(shouldRedact(key), true, key)
      }
    })

    test('keeps non-content metadata', () => {
      for (const key of ['gen_ai.request.model', 'gen_ai.usage.input_tokens', 'gen_ai.tool.name', 'session.id']) {
        assert.strictEqual(shouldRedact(key), false, key)
      }
    })
  })

  suite('safeFilenamePart', () => {
    test('keeps the normal collector paths readable', () => {
      assert.strictEqual(safeFilenamePart('/v1/traces', 'main'), 'v1-traces')
      assert.strictEqual(safeFilenamePart('', 'main'), 'main')
    })

    test('strips separators and parent-directory segments of both OSes', () => {
      for (const raw of ['/../../etc/passwd', '..\\..\\Windows\\evil', 'a/../../b', '....//x', 'C:\\x']) {
        const out = safeFilenamePart(raw, 'main')
        assert.ok(!out.includes('/') && !out.includes('\\') && !out.includes('..') && !out.includes(':'), `${raw} → ${out}`)
      }
      assert.strictEqual(safeFilenamePart('../..', 'main'), 'main')
    })
  })
})
