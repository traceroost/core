import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, splitCodexLinesOnPromptGaps, SESSION_SPLIT_GAP_MS } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

function threadSettingsApplied(ts: string) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'thread_settings_applied' } }
}

function taskStarted(ts: string) {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'task_started', turn_id: 't-' + ts } }
}

function userMessage(ts: string, message = 'hi') {
  return { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message } }
}

/** A turn as Codex actually logs it (confirmed on real data, exhaustively across a whole file):
 *  thread_settings_applied, then task_started <50ms later, then the turn's user_message — all
 *  effectively the same turn timestamp. See splitCodexLinesOnPromptGaps's own comment for why the
 *  split boundary is built on the bookkeeping pair rather than user_message itself. */
function turn(ts: string, message = 'hi'): Record<string, unknown>[] {
  return [threadSettingsApplied(ts), taskStarted(ts), userMessage(ts, message)]
}

function tokenCount(ts: string, cumulativeInput: number, cumulativeOutput: number, cumulativeCachedInput = 0) {
  return {
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5.6-luna',
        total_token_usage: { input_tokens: cumulativeInput, output_tokens: cumulativeOutput, cached_input_tokens: cumulativeCachedInput },
        last_token_usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  }
}

function sessionMeta(ts: string, cwd: string) {
  return { timestamp: ts, type: 'session_meta', payload: { session_id: 'sess', cwd } }
}

suite('splitCodexLinesOnPromptGaps', () => {
  test('a single turn with no gap stays one segment', () => {
    const lines = [...turn('2026-01-01T00:00:00.000Z'), tokenCount('2026-01-01T00:00:05.000Z', 100, 50)].map(l => JSON.stringify(l))
    const segments = splitCodexLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 1)
  })

  test('two turns over the threshold split into two segments', () => {
    const t1 = new Date(Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const lines = [...turn('2026-01-01T00:00:00.000Z'), ...turn(t1)].map(l => JSON.stringify(l))
    const segments = splitCodexLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2)
  })

  test('the boundary walks back before thread_settings_applied, not before user_message — the fix for the real bookkeeping-bleed bug', () => {
    // Reproduces the exact real-data shape: thread_settings_applied then task_started, both
    // <50ms before their turn's user_message, all sharing the *new* turn's timestamp. Splitting
    // on user_message alone (or on task_started alone — an earlier, incomplete version of this
    // fix) would leave one or both bookkeeping lines attached to the end of the previous segment,
    // pulling its measured span forward to the new turn's arrival.
    const t1 = new Date(Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const lines = [...turn('2026-01-01T00:00:00.000Z'), ...turn(t1)].map(l => JSON.stringify(l))
    const segments = splitCodexLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2)
    assert.strictEqual(segments[0].length, 3, 'segment 0 keeps only its own turn, not any of the next turn\'s bookkeeping lines')
    assert.strictEqual(JSON.parse(segments[1][0]).payload.type, 'thread_settings_applied', 'segment 1 starts with the new turn\'s earliest bookkeeping event')
  })

  test('walkback groups an unrecognized near-simultaneous bookkeeping event type too, not just the two already known', () => {
    // Proves the walkback is generic rather than accidentally still keyed to the specific names
    // found so far — uses a synthetic type name that isn't thread_settings_applied/task_started
    // at all, timestamped within WALKBACK_EPSILON_MS of the following task_started/user_message.
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1raw = Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS + 1000
    const t1 = new Date(t1raw).toISOString()
    const t1plus1s = new Date(t1raw + 1000).toISOString()  // within WALKBACK_EPSILON_MS of t1
    const lines = [
      ...turn(t0),
      { timestamp: t1, type: 'event_msg', payload: { type: 'some_future_bookkeeping_event_not_yet_seen' } },
      taskStarted(t1plus1s),
      userMessage(t1plus1s, 'resumed'),
    ].map(l => JSON.stringify(l))
    const segments = splitCodexLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2)
    assert.strictEqual(segments[0].length, 3, 'the unrecognized event type must not remain attached to segment 0')
    assert.strictEqual(JSON.parse(segments[1][0]).payload.type, 'some_future_bookkeeping_event_not_yet_seen')
  })

  test('turn_aborted triggers its own split even when the following thread_settings_applied arrives well outside the walkback epsilon', () => {
    // Reproduces the real-data shape found in a second real transcript: when a turn was left
    // incomplete and the user comes back later, Codex logs turn_aborted stamped with the
    // *resumption* time, but the following turn's own thread_settings_applied/task_started can
    // arrive anywhere from ~0.1s to 31s later (measured across 7 real occurrences in one file) —
    // too inconsistent for WALKBACK_EPSILON_MS (2s) to reliably bridge. turn_aborted has to
    // trigger gap detection on its own rather than depend on being swept in by a later anchor.
    const t0 = '2026-01-01T00:00:00.000Z'
    const abortTs = new Date(Date.parse(t0) + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const newTurnTs = new Date(Date.parse(abortTs) + 31_000).toISOString()  // 31s later — the real worst case found
    const lines = [
      ...turn(t0),
      { timestamp: abortTs, type: 'event_msg', payload: { type: 'turn_aborted' } },
      ...turn(newTurnTs, 'resumed after 3 days'),
    ].map(l => JSON.stringify(l))
    const segments = splitCodexLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2, 'turn_aborted itself must trigger the split, not just the later thread_settings_applied')
    assert.strictEqual(segments[0].length, 3, 'segment 0 keeps only its own turn')
    assert.strictEqual(JSON.parse(segments[1][0]).payload.type, 'turn_aborted', 'segment 1 starts at turn_aborted, not 31s later at thread_settings_applied')
  })

  test('a token_count event does not itself count as a prompt boundary', () => {
    const t1 = new Date(Date.parse('2026-01-01T00:00:00.000Z') + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const lines = [...turn('2026-01-01T00:00:00.000Z'), tokenCount(t1, 100, 50)].map(l => JSON.stringify(l))
    const segments = splitCodexLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 1, 'a token_count event, even after a large gap, must not itself trigger a split')
  })
})

suite('LogReader — Codex session splitting (integration)', () => {
  let tmpDir: string

  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-codex-split-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('a normal short session produces exactly one result with the unsuffixed session id', () => {
    const filePath = path.join(tmpDir, 'sess-normal.jsonl')
    writeJsonl(filePath, [
      sessionMeta('2026-01-01T00:00:00.000Z', '/workspace'),
      ...turn('2026-01-01T00:00:01.000Z', 'first'),
      tokenCount('2026-01-01T00:00:05.000Z', 1000, 200),
    ])
    const results = new LogReader().parseFile(filePath, 'codex')
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].card.sessionId, 'sess-normal')
    assert.strictEqual(results[0].card.conversationId, undefined, 'a file that never split has no group to color-code')
  })

  test('a real multi-day gap splits into two sessions, each reporting only its own token delta', () => {
    // Reproduces the real-world shape found in an actual Codex transcript: total_token_usage
    // climbs monotonically across the whole file with no resets, even across a multi-day gap.
    const filePath = path.join(tmpDir, 'sess-gapped.jsonl')
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1 = '2026-01-01T00:00:05.000Z'
    const t2 = new Date(Date.parse(t0) + 3 * 24 * 3600_000).toISOString()  // 3 days later
    const t3 = new Date(Date.parse(t2) + 5000).toISOString()
    writeJsonl(filePath, [
      sessionMeta(t0, '/workspace'),
      ...turn(t0, 'day one work'),
      tokenCount(t1, 16000, 150, 0),          // cumulative after segment 1's own turn
      ...turn(t2, 'day four work'),
      tokenCount(t3, 33700, 2200, 500),       // cumulative after segment 2's own turn — includes segment 1's 16000/150
    ])

    const results = new LogReader().parseFile(filePath, 'codex')
    assert.strictEqual(results.length, 2, 'expected the 3-day gap to split into two sessions')

    // Segment 0: no baseline, so its totals equal the raw cumulative values at that point.
    assert.strictEqual(results[0].card.sessionId, 'sess-gapped')
    assert.strictEqual(results[0].card.inputTokens, 16000)
    assert.strictEqual(results[0].card.outputTokens, 150)

    // Segment 1: must report only its OWN delta (33700-16000 input, 2200-150 output, 500-0
    // cached), not the full cumulative total that would double-count segment 0's tokens.
    assert.strictEqual(results[1].card.sessionId, 'sess-gapped#1')
    assert.strictEqual(results[1].card.inputTokens, 500 + (33700 - 500 - 16000), 'cacheReadTokens + raw input delta')
    assert.strictEqual(results[1].card.cacheReadTokens, 500)
    assert.strictEqual(results[1].card.outputTokens, 2200 - 150)

    // Both segments came from the same file, so the Sessions table can color-code them as one
    // conversation split apart — see .staged-issues/color-code-multi-segment-conversations.md.
    assert.strictEqual(results[0].card.conversationId, 'sess-gapped')
    assert.strictEqual(results[1].card.conversationId, 'sess-gapped')
  })

  test('a segment with no token_count events of its own inherits (does not reset) the running baseline for the next segment', () => {
    const filePath = path.join(tmpDir, 'sess-empty-middle.jsonl')
    const t0 = '2026-01-01T00:00:00.000Z'
    const t1 = new Date(Date.parse(t0) + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const t2 = new Date(Date.parse(t1) + SESSION_SPLIT_GAP_MS + 1000).toISOString()
    const t3 = new Date(Date.parse(t2) + 5000).toISOString()
    writeJsonl(filePath, [
      sessionMeta(t0, '/workspace'),
      ...turn(t0, 'first'),
      tokenCount(t0, 10000, 100),
      ...turn(t1, 'second, no token_count event follows'),  // segment 1: no usage of its own
      ...turn(t2, 'third'),
      tokenCount(t3, 25000, 500),  // segment 2's cumulative — must diff against segment 0's 10000/100, not segment 1's (nonexistent) usage
    ])

    const results = new LogReader().parseFile(filePath, 'codex')
    assert.strictEqual(results.length, 3)
    assert.strictEqual(results[0].card.inputTokens, 10000)
    assert.strictEqual(results[1].card.inputTokens, 0, 'segment with no token_count events reports zero tokens of its own')
    assert.strictEqual(results[2].card.inputTokens, 25000 - 10000, 'segment 2 diffs against the last real baseline (segment 0), skipping over segment 1')
  })
})
