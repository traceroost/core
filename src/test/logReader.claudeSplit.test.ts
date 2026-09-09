import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, splitClaudeLinesOnPromptGaps, claudeSegmentSessionId, dedupeByUuid, SESSION_SPLIT_GAP_MS } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

function userLine(ts: string, text = 'hi', extra: Record<string, unknown> = {}) {
  return { type: 'user', cwd: '/workspace', timestamp: ts, message: { content: text }, ...extra }
}

function assistantLine(ts: string) {
  return {
    type: 'assistant', timestamp: ts,
    message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] },
  }
}

suite('splitClaudeLinesOnPromptGaps', () => {
  test('empty input returns no segments', () => {
    assert.deepStrictEqual(splitClaudeLinesOnPromptGaps([]), [])
  })

  test('a single prompt with no gap stays one segment', () => {
    const lines = [userLine('2026-01-01T00:00:00.000Z'), assistantLine('2026-01-01T00:00:05.000Z')].map(l => JSON.stringify(l))
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 1)
    assert.strictEqual(segments[0].length, 2)
  })

  test('two prompts under the threshold stay one segment', () => {
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine('2026-01-01T00:00:05.000Z'),
      userLine(new Date(Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS - 1000).toISOString()),
    ].map(l => JSON.stringify(l))
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 1)
    assert.strictEqual(segments[0].length, 3)
  })

  test('two prompts over the threshold split into two segments, boundary right before the second prompt', () => {
    const secondPromptTs = new Date(Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const lines = [
      userLine('2026-01-01T00:00:00.000Z'),
      assistantLine('2026-01-01T00:00:05.000Z'),
      userLine(secondPromptTs),
      assistantLine(secondPromptTs),
    ].map(l => JSON.stringify(l))
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2)
    assert.strictEqual(segments[0].length, 2)
    assert.strictEqual(segments[1].length, 2)
    assert.deepStrictEqual(JSON.parse(segments[1][0]).timestamp, secondPromptTs)
  })

  test('three prompts, one large gap, produces three segments only where gaps actually exceed the threshold', () => {
    const t0 = Date.parse('2026-01-01T00:00:00.000Z')
    const t1 = t0 + 5 * 60_000                       // 5 min later — no split
    const t2 = t1 + SESSION_SPLIT_GAP_MS + 60_000     // well over the threshold — split
    const lines = [
      userLine(new Date(t0).toISOString()),
      userLine(new Date(t1).toISOString()),
      userLine(new Date(t2).toISOString()),
    ].map(l => JSON.stringify(l))
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2)
    assert.strictEqual(segments[0].length, 2)
    assert.strictEqual(segments[1].length, 1)
  })

  test('malformed lines are skipped without breaking segmentation', () => {
    const secondPromptTs = new Date(Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const lines = [
      JSON.stringify(userLine('2026-01-01T00:00:00.000Z')),
      'not valid json',
      JSON.stringify(userLine(secondPromptTs)),
    ]
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2)
    assert.strictEqual(segments[0].length, 2)  // the good user line + the malformed line stay together
    assert.strictEqual(segments[1].length, 1)
  })

  test('a single out-of-order timestamp does not corrupt the gap baseline for later comparisons', () => {
    // Confirmed on real transcript data: an isolated user entry can be stamped noticeably earlier
    // than its neighbors (observed from Claude Code's own resume/continuation handling). Using the
    // last-seen timestamp as the gap baseline would let this one stray entry make every subsequent
    // real prompt look like a huge gap; tracking the max-seen timestamp instead should not.
    const t0 = Date.parse('2026-01-02T12:00:00.000Z')
    const strayEarlier = t0 - 24 * 3600_000  // a full day earlier, out of order
    const t1 = t0 + 5 * 60_000               // 5 min after t0 — should NOT read as a gap from t0
    const lines = [
      userLine(new Date(t0).toISOString()),
      userLine(new Date(strayEarlier).toISOString()),
      userLine(new Date(t1).toISOString()),
    ].map(l => JSON.stringify(l))
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 1, 'the stray earlier timestamp should not itself trigger a split, nor corrupt the next comparison')
  })

  test('a user entry with no parseable timestamp never triggers a split', () => {
    const lines = [
      JSON.stringify(userLine('2026-01-01T00:00:00.000Z')),
      JSON.stringify({ type: 'user', message: { content: 'no timestamp' } }),
      JSON.stringify(userLine('2026-01-01T00:00:01.000Z')),
    ]
    const segments = splitClaudeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 1)
  })
})

suite('claudeSegmentSessionId', () => {
  test('segment 0 keeps the base session id unchanged', () => {
    assert.strictEqual(claudeSegmentSessionId('abc-123', 0), 'abc-123')
  })

  test('later segments get a stable, distinct suffix', () => {
    assert.strictEqual(claudeSegmentSessionId('abc-123', 1), 'abc-123#1')
    assert.strictEqual(claudeSegmentSessionId('abc-123', 2), 'abc-123#2')
  })
})

suite('dedupeByUuid', () => {
  test('keeps the first occurrence of a uuid and drops later repeats', () => {
    const lines = [
      JSON.stringify(userLine('2026-01-01T00:00:00.000Z', 'first', { uuid: 'a' })),
      JSON.stringify(userLine('2026-01-01T00:01:00.000Z', 'second', { uuid: 'b' })),
      // Same uuid as the first line, but re-serialized much later with an extra field and an old
      // timestamp — the exact real-world shape found in a live transcript (a replayed history
      // block, same uuid/timestamp, one added field).
      JSON.stringify(userLine('2026-01-01T00:00:00.000Z', 'first', { uuid: 'a', slug: 'added-later' })),
    ]
    const result = dedupeByUuid(lines)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(JSON.parse(result[0]).message.content, 'first')
    assert.strictEqual(JSON.parse(result[1]).message.content, 'second')
  })

  test('leaves lines with no uuid untouched — never deduplicated', () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:01.000Z' }),
    ]
    const result = dedupeByUuid(lines)
    assert.strictEqual(result.length, 2)
  })

  test('a malformed line passes through unchanged rather than being dropped', () => {
    const result = dedupeByUuid(['not valid json'])
    assert.deepStrictEqual(result, ['not valid json'])
  })
})

suite('LogReader — Claude Code session splitting (integration)', () => {
  let tmpDir: string

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-claude-split-'))
  })

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('a normal short session (no large gap) produces exactly one result with the unsuffixed session id', () => {
    const filePath = path.join(tmpDir, 'sess-normal.jsonl')
    writeJsonl(filePath, [
      userLine('2026-01-01T00:00:00.000Z', 'first thing'),
      assistantLine('2026-01-01T00:00:05.000Z'),
      userLine('2026-01-01T00:05:00.000Z', 'second thing'),
      assistantLine('2026-01-01T00:05:05.000Z'),
    ])

    const results = new LogReader().parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].card.sessionId, 'sess-normal')
    assert.strictEqual(results[0].card.userRequest, 'first thing')
    assert.strictEqual(results[0].card.conversationId, undefined, 'a file that never split has no group to color-code')
  })

  test('a session with a real multi-hour gap between prompts splits into two sessions, each with its own prompt and totals', () => {
    const filePath = path.join(tmpDir, 'sess-gapped.jsonl')
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1 = '2026-01-01T00:00:05.000Z'
    const t2 = new Date(Date.parse(t0) + 5 * 3600_000).toISOString()  // 5 hours later — the reported bug scenario
    const t3 = new Date(Date.parse(t2) + 5000).toISOString()
    writeJsonl(filePath, [
      userLine(t0, 'work on the first task'),
      assistantLine(t1),
      userLine(t2, 'come back and work on something else'),
      assistantLine(t3),
    ])

    const results = new LogReader().parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 2, 'expected the 5-hour gap to split into two sessions')

    assert.strictEqual(results[0].card.sessionId, 'sess-gapped')
    assert.strictEqual(results[0].card.userRequest, 'work on the first task')
    assert.strictEqual(results[0].card.turns, 1)

    assert.strictEqual(results[1].card.sessionId, 'sess-gapped#1')
    assert.strictEqual(results[1].card.userRequest, 'come back and work on something else')
    assert.strictEqual(results[1].card.turns, 1)

    // Each segment's own wall-clock duration should be small — nowhere near the 5-hour gap that
    // used to be baked into one session's durationMs before this fix.
    assert.ok(results[0].card.durationMs < 60_000)
    assert.ok(results[1].card.durationMs < 60_000)

    // Both segments came from the same file, so the Sessions table can color-code them as one
    // conversation split apart — see .staged-issues/color-code-multi-segment-conversations.md.
    assert.strictEqual(results[0].card.conversationId, 'sess-gapped')
    assert.strictEqual(results[1].card.conversationId, 'sess-gapped')
  })

  test('re-scanning an unchanged split file returns no results (cache behavior preserved)', () => {
    const filePath = path.join(tmpDir, 'sess-gapped-2.jsonl')
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1 = new Date(Date.parse(t0) + SESSION_SPLIT_GAP_MS + 60_000).toISOString()
    writeJsonl(filePath, [userLine(t0, 'first'), userLine(t1, 'second')])

    const reader = new LogReader()
    const first = reader.parseFile(filePath, 'claude')
    assert.strictEqual(first.length, 2)

    const second = reader.parseFile(filePath, 'claude')
    assert.strictEqual(second.length, 0, 'unchanged file should produce no new results on rescan')
  })

  test('a replayed history block (duplicate uuids, real-world shape) does not inflate turns or corrupt segmentation', () => {
    // Reproduces the exact shape found in a live transcript: a normal short session, followed
    // much later in the file by a re-serialized copy of its own early entries — same uuid, same
    // (old) timestamp, one added field — the way Claude Code appears to replay history on resume.
    const filePath = path.join(tmpDir, 'sess-replayed.jsonl')
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1 = '2026-01-01T00:00:05.000Z'
    writeJsonl(filePath, [
      userLine(t0, 'original prompt', { uuid: 'u1' }),
      assistantLine(t1),
      // Much later in the file, but stamped with the *original* early timestamp and uuid —
      // exactly the anomaly found on real data.
      userLine(t0, 'original prompt', { uuid: 'u1', slug: 'added-by-a-later-version' }),
    ])

    const results = new LogReader().parseFile(filePath, 'claude')
    assert.strictEqual(results.length, 1, 'the replayed duplicate must not be read as a second real prompt')
    assert.strictEqual(results[0].card.turns, 1, 'the duplicate entry must not double-count as a second turn')
    assert.ok(results[0].card.durationMs < 60_000, 'duration must reflect only the real span, not the duplicate\'s stale timestamp')
  })
})
