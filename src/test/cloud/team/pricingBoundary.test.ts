import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

// The pricing-boundary doc is the source of the pricing-page copy (AL 09). This pins the load-
// bearing sentences so an edit that softens the boundary trips CI. When the alsaas repo is
// reconciled, this becomes a cross-repo fixture check against the rendered pricing page.
const DOC = fs.readFileSync(path.join(process.cwd(), 'docs', 'pricing-boundary.md'), 'utf-8')

suite('docs/pricing-boundary', () => {
  test('states the boundary in one line', () => {
    assert.match(DOC, /\*\*Free is my machine\. Paid is everyone's\.\*\*/)
  })

  test('carries all four refusals', () => {
    for (const refusal of [
      'No feature is removed from free',
      'No quotas',
      'No trial',
      'No free self-hostable',
    ]) {
      assert.ok(DOC.includes(refusal), `missing refusal: ${refusal}`)
    }
  })

  test('states the free-self-hosting scope', () => {
    assert.match(DOC.replace(/\s+/g, ' '), /Free self-hosting means the single-developer local tool/)
  })

  test('names the hand-off commands', () => {
    assert.match(DOC, /agentlens cohort --repo <hash\|name> --merged/)
    assert.match(DOC, /agentlens:\/\/cohort/)
  })
})
