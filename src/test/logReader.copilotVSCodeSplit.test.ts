import * as assert from 'assert'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { LogReader, splitCopilotVSCodeLinesOnPromptGaps, SESSION_SPLIT_GAP_MS } from '../logReader'

function writeJsonl(filePath: string, lines: Record<string, unknown>[]) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

function snapshot(creationDateMs: number, model = 'copilot/gpt-5.6-luna') {
  return {
    kind: 0,
    v: {
      version: 3, creationDate: creationDateMs, sessionId: 'sess',
      requests: [], inputState: { selectedModel: { id: model, metadata: { family: model.replace(/^copilot\//, '') } } },
    },
  }
}

/** One `kind: 2` push adding a single new turn — the format's own "new prompt" signal. */
function requestsPush(ts: number, message = 'hi', completionTokens?: number) {
  const req: Record<string, unknown> = { requestId: 'r-' + ts, timestamp: ts, message: { text: message } }
  if (completionTokens !== undefined) req['completionTokens'] = completionTokens
  return { kind: 2, k: ['requests'], v: [req] }
}

/** A late-arriving completionTokens update (Format A) — idx addresses the *global* position in
 *  the whole session's requests array, which is what the startingTurnIndex plumbing exists for. */
function completionTokensSet(idx: number, tokens: number) {
  return { kind: 1, k: ['requests', idx, 'completionTokens'], v: tokens }
}

suite('splitCopilotVSCodeLinesOnPromptGaps', () => {
  test('a single turn with no gap stays one segment', () => {
    const lines = [snapshot(1000), requestsPush(1000, 'hi', 5)].map(l => JSON.stringify(l))
    assert.strictEqual(splitCopilotVSCodeLinesOnPromptGaps(lines).length, 1)
  })

  test('two turns over the threshold split into two segments', () => {
    const lines = [snapshot(1000), requestsPush(1000), requestsPush(1000 + SESSION_SPLIT_GAP_MS + 1000)].map(l => JSON.stringify(l))
    assert.strictEqual(splitCopilotVSCodeLinesOnPromptGaps(lines).length, 2)
  })

  test('a kind=1 update alone (no timestamp) is never itself a prompt boundary', () => {
    const lines = [snapshot(1000), requestsPush(1000), completionTokensSet(0, 42)].map(l => JSON.stringify(l))
    assert.strictEqual(splitCopilotVSCodeLinesOnPromptGaps(lines).length, 1)
  })

  test('a batched push of two requests uses the first request\'s timestamp for gap detection', () => {
    const t0 = 1000
    const t1 = t0 + SESSION_SPLIT_GAP_MS + 1000
    const batchPush = { kind: 2, k: ['requests'], v: [
      { requestId: 'a', timestamp: t1, message: { text: 'first of the batch' } },
      { requestId: 'b', timestamp: t1 + 500, message: { text: 'second of the batch' } },
    ] }
    const lines = [snapshot(t0), requestsPush(t0), batchPush].map(l => JSON.stringify(l))
    const segments = splitCopilotVSCodeLinesOnPromptGaps(lines)
    assert.strictEqual(segments.length, 2, 'the batch push as a whole must still trigger the split (gap from t0)')
    assert.strictEqual(segments[1].length, 1, 'the whole batch line stays together — a line can\'t be split internally')
  })
})

suite('LogReader — Copilot VS Code chat session splitting (integration)', () => {
  let tmpDir: string

  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-copilot-vscode-split-')) })
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

  test('a normal short session produces exactly one result with the unsuffixed session id', () => {
    const filePath = path.join(tmpDir, 'sess-normal.jsonl')
    writeJsonl(filePath, [
      snapshot(1000),
      requestsPush(1000, 'first', 10),
    ])
    const results = new LogReader().parseFile(filePath, 'copilot_vscode')
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].card.sessionId, 'sess-normal')
    assert.strictEqual(results[0].card.conversationId, undefined, 'a file that never split has no group to color-code')
  })

  test('a real multi-hour gap splits into two sessions, each with its own prompt', () => {
    const filePath = path.join(tmpDir, 'sess-gapped.jsonl')
    const t0 = 1_700_000_000_000
    const t1 = t0 + SESSION_SPLIT_GAP_MS + 3600_000  // over an hour past the threshold
    writeJsonl(filePath, [
      snapshot(t0),
      requestsPush(t0, 'day one work', 10),
      requestsPush(t1, 'day two work', 20),
    ])

    const results = new LogReader().parseFile(filePath, 'copilot_vscode')
    assert.strictEqual(results.length, 2, 'expected the gap to split into two sessions')
    assert.strictEqual(results[0].card.sessionId, 'sess-gapped')
    assert.strictEqual(results[0].card.userRequest, 'day one work')
    assert.strictEqual(results[1].card.sessionId, 'sess-gapped#1')
    assert.strictEqual(results[1].card.userRequest, 'day two work')

    // Both segments came from the same file, so the Sessions table can color-code them as one
    // conversation split apart — see .staged-issues/color-code-multi-segment-conversations.md.
    assert.strictEqual(results[0].card.conversationId, 'sess-gapped')
    assert.strictEqual(results[1].card.conversationId, 'sess-gapped')
  })

  test('segment 0 uses its own first turn\'s timestamp, not the chat panel\'s creation time, as its start', () => {
    // Reproduces the real-data finding: a chat panel can sit open for hours before its first real
    // message, which made sessionCreatedMs alone show a 66-73 hour "duration" on real files whose
    // actual turns spanned well under 90 minutes. creationDate here is 5 hours before the first
    // real turn — startTime/durationMs must reflect the turn, not the panel's creation.
    const filePath = path.join(tmpDir, 'sess-stale-creation-date.jsonl')
    const panelCreatedMs = 1_700_000_000_000
    const firstTurnMs = panelCreatedMs + 5 * 3600_000
    const secondTurnMs = firstTurnMs + 5 * 60_000
    writeJsonl(filePath, [
      snapshot(panelCreatedMs),
      requestsPush(firstTurnMs, 'finally typed something', 10),
      requestsPush(secondTurnMs, 'a follow-up', 5),
    ])
    const results = new LogReader().parseFile(filePath, 'copilot_vscode')
    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].card.startTime, new Date(firstTurnMs).toISOString())
    assert.ok(results[0].card.durationMs < 60 * 60_000, 'duration should reflect the ~5min between turns, not the 5+ hours since panel creation')
  })

  test('a segment after the first still has a usable start time despite no kind=0 snapshot of its own', () => {
    // sessionCreatedMs (the kind=0 snapshot) only appears once, in segment 0 — segment 1 must
    // fall back to its own earliest turn timestamp rather than being dropped for lack of one.
    const filePath = path.join(tmpDir, 'sess-no-snapshot-in-later-segment.jsonl')
    const t0 = 1_700_000_000_000
    const t1 = t0 + SESSION_SPLIT_GAP_MS + 3600_000
    writeJsonl(filePath, [
      snapshot(t0),
      requestsPush(t0, 'first', 10),
      requestsPush(t1, 'second', 20),
    ])
    const results = new LogReader().parseFile(filePath, 'copilot_vscode')
    assert.strictEqual(results.length, 2)
    assert.strictEqual(results[1].card.startTime, new Date(t1).toISOString())
  })

  test('a late-arriving completionTokens update in a later segment addresses the correct turn via startingTurnIndex', () => {
    // Reproduces the format's real correctness wrinkle: kind=1 updates address a request by its
    // position in the *whole session's* requests array, not a position relative to whichever
    // segment it falls in. Segment 1 here is the file's 2nd turn overall (global index 1) — its
    // own completionTokens update must land on that global index, not reset to a local index 0.
    const filePath = path.join(tmpDir, 'sess-global-index.jsonl')
    const t0 = 1_700_000_000_000
    const t1 = t0 + SESSION_SPLIT_GAP_MS + 3600_000
    writeJsonl(filePath, [
      snapshot(t0),
      requestsPush(t0, 'first', 10),          // global index 0
      requestsPush(t1, 'second'),             // global index 1 — no completionTokens in the push itself
      completionTokensSet(1, 25),             // late-arriving update, addresses global index 1
    ])
    const results = new LogReader().parseFile(filePath, 'copilot_vscode')
    assert.strictEqual(results.length, 2)
    assert.strictEqual(results[0].card.outputTokens, 10)
    assert.strictEqual(results[1].card.outputTokens, 25, 'the late completionTokens update must land on segment 1\'s own turn, not be lost or miscounted')
  })
})
