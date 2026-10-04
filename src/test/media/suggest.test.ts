import * as assert from 'assert'
import { SUGGEST_URL, suggestionUrl } from '../../../media/src/suggest'

suite('suggestionUrl (header "Make a suggestion" link)', () => {
  test('points at the public /suggest page with from=core and an encoded version · tab context', () => {
    const url = new URL(suggestionUrl('1.2.3', 'Traces'))
    assert.strictEqual(`${url.origin}${url.pathname}`, SUGGEST_URL)
    assert.deepStrictEqual([...url.searchParams.keys()], ['from', 'context'])
    assert.strictEqual(url.searchParams.get('from'), 'core')
    assert.strictEqual(url.searchParams.get('context'), 'core 1.2.3 · Traces')
    // Spaces and the middle dot are percent-encoded, not passed raw.
    assert.ok(!/[ ·]/.test(url.search), url.search)
  })

  test('omits the version when the host did not provide one', () => {
    const url = new URL(suggestionUrl(undefined, 'Help'))
    assert.strictEqual(url.searchParams.get('context'), 'core · Help')
  })

  test('a tab label with URL syntax cannot add parameters', () => {
    const url = new URL(suggestionUrl('1.0.0', 'A&workspace=/home/me/repo#x'))
    assert.deepStrictEqual([...url.searchParams.keys()], ['from', 'context'])
    assert.strictEqual(url.searchParams.get('context'), 'core 1.0.0 · A&workspace=/home/me/repo#x')
  })
})
