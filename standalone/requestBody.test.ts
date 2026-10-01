import * as assert from 'assert'
import { Readable } from 'stream'
import { readBodyLimited } from './requestBody'

suite('readBodyLimited', () => {
  const stream = (...chunks: string[]) => Readable.from(chunks.map(c => Buffer.from(c)))

  test('returns the whole body at or under the limit', async () => {
    assert.strictEqual((await readBodyLimited(stream('ab', 'cd'), 4))?.toString(), 'abcd')
    assert.strictEqual((await readBodyLimited(stream(), 4))?.toString(), '')
  })

  test('returns null once the body grows past the limit', async () => {
    assert.strictEqual(await readBodyLimited(stream('abc', 'de', 'f'), 4), null)
  })

  test('rejects on a stream error', async () => {
    const s = new Readable({ read() { this.destroy(new Error('boom')) } })
    await assert.rejects(readBodyLimited(s, 4), /boom/)
  })
})
