import * as assert from 'assert'
import { runDoctorCli, type DoctorIo } from './doctorCli'
import { observeRecords } from '../src/adapters/classify'
import type { AdapterHealth } from '../src/adapters/health'

const NOW = Date.parse('2026-11-03T12:00:00Z')

function io(feed: (h: AdapterHealth) => void, server?: unknown): DoctorIo & { out: string[]; err: string[]; opened: string[] } {
  const out: string[] = [], err: string[] = [], opened: string[] = []
  return {
    out, err, opened,
    log: l => out.push(l),
    error: l => err.push(l),
    fetchServerHealth: async () => server,
    scanLocal: async h => feed(h),
    setupState: () => 'logs only',
    open: url => opened.push(url),
    now: () => NOW,
  }
}

const claudeClean = (h: AdapterHealth) => h.observeFile('/a.jsonl', observeRecords('claude', [
  { type: 'user', message: {}, timestamp: 't', uuid: 'u', version: '2.1.310' },
  { type: 'assistant', message: { usage: {} }, timestamp: 't' },
])!)

const codexRecords = () => observeRecords('codex', [
  { type: 'session_meta', payload: { id: 'x', cwd: '/secret/repo', cli_version: '0.162.0' } },
  { type: 'turn_summary_record', payload: { tokens: 12, note: 'a private value' } },
  { type: 'turn_summary_record', payload: { tokens: 3 } },
])!
// The rollout gave no turns: lost data.
const codexBroken = (h: AdapterHealth) => h.observeFile('/r.jsonl', { ...codexRecords(), turns: 0 }, NOW)
// Its turns were read: the unknown records were only skipped.
const codexSkipped = (h: AdapterHealth) => h.observeFile('/r.jsonl', { ...codexRecords(), turns: 2 }, NOW)

suite('traceroost doctor', () => {
  test('exits 0 with a row per agent when nothing is unrecognized', async () => {
    const t = io(claudeClean)
    assert.strictEqual(await runDoctorCli([], t), 0)
    const text = t.out.join('\n')
    assert.match(text, /^Agent\s+Version seen\s+Last data\s+Setup\s+Status/m)
    assert.match(text, /Claude Code\s+2\.1\.310\s+just now\s+logs only\s+Not verified on this version/)
    assert.match(text, /Cursor CLI\s+—\s+never\s+logs only\s+No data/)
    assert.match(text, /none answered — this is from local log files only/)
  })

  test('exits 1 on lost data, naming the unrecognized records and how to report them', async () => {
    const t = io(h => { claudeClean(h); codexBroken(h) })
    assert.strictEqual(await runDoctorCli([], t), 1)
    const text = t.out.join('\n')
    assert.match(text, /Codex\s+0\.162\.0\s+.*Missing data/)
    assert.match(text, /Codex 0\.162\.0: 2 unrecognized of 3 records — turn_summary_record ×2/)
    assert.match(text, /1 session file gave no turns: missing from Traces/)
    assert.match(text, /traceroost doctor --report codex/)
  })

  test('exits 0 when unrecognized records were only skipped, and still lists them', async () => {
    const t = io(codexSkipped)
    assert.strictEqual(await runDoctorCli([], t), 0)
    const text = t.out.join('\n')
    assert.match(text, /Codex\s+0\.162\.0\s+.*Unrecognized data/)
    assert.match(text, /turn_summary_record ×2\n  Skipped; its sessions were still read\./)
  })

  test('adds the running server\'s OTLP counts', async () => {
    const server = { v: 1, files: {}, otlp: { 'claude\u00002.1.311': { adapter: 'claude', version: '2.1.311', known: 4, ignored: 0, unknown: 0, unknownNames: {}, unknownFingerprints: {}, seenMs: NOW - 120_000 } } }
    const t = io(() => { /* no files */ }, server)
    assert.strictEqual(await runDoctorCli([], t), 0)
    assert.match(t.out.join('\n'), /Claude Code\s+2\.1\.311\s+2m ago/)
    assert.ok(!t.out.join('\n').includes('none answered'))
  })

  test('--report prints the whole issue: names, counts and structure, never a value; --open opens it', async () => {
    const t = io(codexBroken)
    assert.strictEqual(await runDoctorCli(['--report', 'codex', '--open'], t), 0)
    const text = t.out.join('\n')
    assert.match(text, /Codex 0\.162\.0: unrecognized data/)
    assert.match(text, /\| `turn_summary_record` \| 2 \|/)
    assert.match(text, /"tokens": "number"/)
    for (const value of ['a private value', '/secret/repo']) assert.ok(!text.includes(value), `leaked ${value}`)
    assert.strictEqual(t.opened.length, 1)
    assert.ok(t.opened[0].startsWith('https://github.com/traceroost/core/issues/new?'))
    assert.ok(!decodeURIComponent(t.opened[0]).includes('a private value'))
  })

  test('--report for an agent with nothing unrecognized says so; bad arguments exit 2', async () => {
    const t = io(claudeClean)
    assert.strictEqual(await runDoctorCli(['--report', 'claude'], t), 0)
    assert.match(t.out.join('\n'), /nothing unrecognized/)
    assert.strictEqual(await runDoctorCli(['--report', 'nope'], io(claudeClean)), 2)
    assert.strictEqual(await runDoctorCli(['--open'], io(claudeClean)), 2)
    assert.strictEqual(await runDoctorCli(['--bogus'], io(claudeClean)), 2)
  })
})
