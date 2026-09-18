import * as assert from 'assert'
import * as crypto from 'crypto'
import { buildCommitRecords, type CommitAttributionInput } from '../../../cloud/forward/buildCommitRecords'
import { authorHash, type RepoKeyContext } from '../../../cloud/forward/repoKey'

const CTX: RepoKeyContext = { root: '/repo', key: crypto.createHash('sha256').update('test-key').digest() }

function makeCommit(overrides: Partial<CommitAttributionInput> = {}): CommitAttributionInput {
  return {
    sha: 'a'.repeat(40),
    authoredAt: '2026-05-01T00:00:00.000Z',
    linesAdded: 10,
    linesRemoved: 2,
    aiLines: 5,
    attribution: 'certain',
    ...overrides,
  }
}

suite('forward/buildCommitRecords', () => {
  test('a commit with authorEmail gets an author_hash matching repoKey.ts\'s authorHash', () => {
    const [record] = buildCommitRecords([makeCommit({ authorEmail: 'dev@example.com' })], CTX)
    assert.strictEqual(record.author_hash, authorHash(CTX, 'dev@example.com'))
    assert.match(record.author_hash!, /^[a-f0-9]{64}$/)
  })

  test('a commit with no authorEmail omits author_hash entirely (not null, not empty string)', () => {
    const [record] = buildCommitRecords([makeCommit()], CTX)
    assert.strictEqual('author_hash' in record, false)
  })

  test('two different author emails on two commits produce two different author_hash values', () => {
    const [a, b] = buildCommitRecords(
      [
        makeCommit({ sha: 'a'.repeat(40), authorEmail: 'a@example.com' }),
        makeCommit({ sha: 'b'.repeat(40), authorEmail: 'b@example.com' }),
      ],
      CTX,
    )
    assert.notStrictEqual(a.author_hash, b.author_hash)
  })

  test('author_hash never leaks the raw email', () => {
    const MARKER = 'SENSITIVE_EMAIL_MARKER'
    const [record] = buildCommitRecords([makeCommit({ authorEmail: `${MARKER}@example.com` })], CTX)
    assert.ok(!JSON.stringify(record).includes(MARKER))
  })
})
