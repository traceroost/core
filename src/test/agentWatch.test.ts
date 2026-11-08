// scripts/agent-watch.mjs (the release watcher) with a fake fetch standing in for npm, the VS Code
// Marketplace, Cursor's install script and the GitHub API; and tests/e2e/fingerprint-diff.mjs run
// the way agent-capture.yml runs it, against a doctored copy of a committed fixture.
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { pathToFileURL } from 'url'

const ROOT = path.resolve(__dirname, '..', '..', '..')
// A real dynamic import (not compiled to require): the scripts are ES modules.
const importEsm = new Function('p', 'return import(p)') as (p: string) => Promise<Record<string, unknown>>

interface Call { method: string; url: string; body?: unknown }
type Watch = {
  check(o: Record<string, unknown>): Promise<{ text: string; changes: Array<{ issue?: number }>; errors: unknown[]; firstRun: boolean; subject: string | null }>
  report(o: Record<string, unknown>): Promise<{ title: string; body: string; mailed: boolean }>
  latestVersion(source: unknown, f: unknown): Promise<string>
  mailsOutcome(agentKey: string, outcome: string): boolean
  captureSkipList(env: Record<string, string | undefined>): Set<string>
}

function fakeFetch(versions: Record<string, string | Error>, issues: Array<{ number: number; title: string }> = []) {
  const calls: Call[] = []
  const json = (v: unknown, status = 200) => ({ ok: status < 400, status, json: async () => v, text: async () => JSON.stringify(v) })
  const impl = async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined })
    const fail = (k: string) => versions[k] instanceof Error
    if (url.includes('/dist-tags')) {
      const pkg = decodeURIComponent(url.split('/-/package/')[1].split('/dist-tags')[0]).replace('%2f', '/')
      return fail(pkg) ? json({}, 503) : json({ latest: versions[pkg] })
    }
    if (url.includes('extensionquery')) return json({ results: [{ extensions: [{ versions: [
      { version: '0.49.0-pre', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] },
      { version: versions['copilot-chat'], properties: [] },
    ] }] }] })
    if (url.includes('cursor')) return { ok: true, status: 200, text: async () => `curl -fsSL "https://downloads.cursor.com/lab/${versions['cursor']}/linux/x64/agent-cli-package.tar.gz"` }
    if (url.includes('/issues') && method === 'GET') return json(issues.map(i => ({ ...i, labels: [{ name: 'agent-release' }] })))
    if (url.endsWith('/issues') && method === 'POST') return json({ number: 77 }, 201)
    if (url.includes('/dispatches')) return { ok: true, status: 204, json: async () => ({}), text: async () => '' }
    return json({})
  }
  return { impl, calls }
}

const V = { '@anthropic-ai/claude-code': '2.1.318', '@openai/codex': '0.166.0', 'opencode-ai': '1.19.5', '@github/copilot': '1.0.105', 'copilot-chat': '0.48.1', cursor: '2026.10.22-27dcf5f' }

suite('agent-watch — release watcher', () => {
  let watch: Watch
  let dir: string
  const saved = { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, GITHUB_API_URL: process.env.GITHUB_API_URL }
  suiteSetup(async () => { watch = await importEsm(pathToFileURL(path.join(ROOT, 'scripts', 'agent-watch.mjs')).href) as unknown as Watch })
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watch-'))
    process.env.GITHUB_REPOSITORY = 'traceroost/core'
    process.env.GITHUB_API_URL = 'https://api.test'
  })
  // Only the keys set here: replacing process.env itself detaches it from the real environment,
  // and later tests that set HOME would no longer move os.homedir().
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })

  test('the first run records a baseline: no issue, no dispatch, a baseline mail subject', async () => {
    const f = fakeFetch(V)
    const r = await watch.check({ statePath: path.join(dir, 'state.json'), fetchImpl: f.impl })
    assert.strictEqual(r.firstRun, true)
    assert.strictEqual(r.changes.length, 0)
    assert.match(r.subject ?? '', /baseline recorded/)
    assert.match(r.text, /Copilot \(VS Code\)\*\*: 0\.48\.1 \(baseline\)/)   // the pre-release was skipped
    assert.match(r.text, /Cursor CLI\*\*: 2026\.10\.22-27dcf5f/)
    assert.ok(!f.calls.some(c => c.url.startsWith('https://api.test') && c.method !== 'GET'))
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).seen.codex, '0.166.0')
  })

  test('a new release opens a tracking issue, dispatches a pinned capture and names it in the mail subject', async () => {
    const state = path.join(dir, 'state.json')
    await watch.check({ statePath: state, fetchImpl: fakeFetch(V).impl })
    const f = fakeFetch({ ...V, '@openai/codex': '0.167.0' })
    const r = await watch.check({ statePath: state, fetchImpl: f.impl })
    assert.strictEqual(r.changes.length, 1)
    assert.strictEqual(r.subject, 'TraceRoost: new agent release — Codex 0.167.0')
    const created = f.calls.find(c => c.method === 'POST' && c.url.endsWith('/repos/traceroost/core/issues'))!
    assert.deepStrictEqual(created.body, { title: 'Codex 0.167.0 released: verification running', body: (created.body as { body: string }).body, labels: ['agent-release'] })
    assert.match((created.body as { body: string }).body, /previously 0\.166\.0/)
    const dispatch = f.calls.find(c => c.url.endsWith('/actions/workflows/agent-capture.yml/dispatches'))!
    assert.deepStrictEqual(dispatch.body, { ref: 'main', inputs: { agent: 'codex', version: '0.167.0', issue: '77' } })
    assert.ok(!f.calls.some(c => /\/(pulls|git|contents)\b/.test(c.url)), 'never touches code')
  })

  test('an open tracking issue for the agent is retitled and commented on, not duplicated', async () => {
    const state = path.join(dir, 'state.json')
    await watch.check({ statePath: state, fetchImpl: fakeFetch(V).impl })
    const f = fakeFetch({ ...V, '@anthropic-ai/claude-code': '2.1.319' }, [{ number: 12, title: 'Claude Code 2.1.318 released: verified, no format change' }, { number: 13, title: 'Codex 0.166.0 released: verification running' }])
    await watch.check({ statePath: state, fetchImpl: f.impl })
    assert.ok(!f.calls.some(c => c.method === 'POST' && c.url.endsWith('/issues')))
    assert.deepStrictEqual(f.calls.find(c => c.method === 'PATCH')!.body, { title: 'Claude Code 2.1.319 released: verification running' })
    assert.ok(f.calls.some(c => c.method === 'POST' && c.url.endsWith('/issues/12/comments')))
  })

  test('Copilot Chat has no headless mode: its issue says check by hand and nothing is dispatched', async () => {
    const state = path.join(dir, 'state.json')
    await watch.check({ statePath: state, fetchImpl: fakeFetch(V).impl })
    const f = fakeFetch({ ...V, 'copilot-chat': '0.49.0' })
    await watch.check({ statePath: state, fetchImpl: f.impl })
    assert.strictEqual((f.calls.find(c => c.method === 'POST' && c.url.endsWith('/issues'))!.body as { title: string }).title, 'Copilot (VS Code) 0.49.0 released: check by hand')
    assert.ok(!f.calls.some(c => c.url.includes('/dispatches')))
  })

  test('an agent whose capture is turned off gets a check-by-hand issue, no capture, and no mail of its own', async () => {
    const state = path.join(dir, 'state.json')
    const skip = watch.captureSkipList({ AGENT_CAPTURE_SKIP: 'cursor, opencode' })
    assert.deepStrictEqual([...skip], ['cursor', 'opencode'])
    await watch.check({ statePath: state, fetchImpl: fakeFetch(V).impl, skip })
    const f = fakeFetch({ ...V, cursor: '2026.11.01-aaaaaaa' })
    const r = await watch.check({ statePath: state, fetchImpl: f.impl, skip })
    const issue = f.calls.find(c => c.method === 'POST' && c.url.endsWith('/issues'))!.body as { title: string; body: string }
    assert.strictEqual(issue.title, 'Cursor CLI 2026.11.01-aaaaaaa released: check by hand')
    assert.match(issue.body, /AGENT_CAPTURE_SKIP/)
    assert.ok(!f.calls.some(c => c.url.includes('/dispatches')))
    assert.strictEqual(r.subject, null)
    // Released alongside an agent that is captured, it is listed in that mail.
    const g = fakeFetch({ ...V, cursor: '2026.11.02-bbbbbbb', '@openai/codex': '0.167.0' })
    const r2 = await watch.check({ statePath: state, fetchImpl: g.impl, skip })
    assert.match(r2.subject ?? '', /Codex 0\.167\.0, Cursor CLI 2026\.11\.02-bbbbbbb/)
    assert.strictEqual(g.calls.filter(c => c.url.includes('/dispatches')).length, 1)
  })

  test('a source that keeps failing is mailed about once, after a day of runs', async () => {
    const state = path.join(dir, 'state.json')
    await watch.check({ statePath: state, fetchImpl: fakeFetch(V).impl })
    const subjects: Array<string | null> = []
    for (let i = 0; i < 5; i++) subjects.push((await watch.check({ statePath: state, fetchImpl: fakeFetch({ ...V, 'opencode-ai': new Error('down') }).impl })).subject)
    assert.deepStrictEqual(subjects, [null, null, null, 'TraceRoost agent release watch: could not check OpenCode for a day', null])
  })

  test('--dry-run reads but writes nothing to GitHub', async () => {
    const state = path.join(dir, 'state.json')
    await watch.check({ statePath: state, fetchImpl: fakeFetch(V).impl })
    const f = fakeFetch({ ...V, '@openai/codex': '0.167.0' })
    const r = await watch.check({ statePath: state, fetchImpl: f.impl, dryRun: true })
    assert.ok(f.calls.filter(c => c.url.startsWith('https://api.test')).every(c => c.method === 'GET'))
    assert.match(r.text, /verification not dispatched/)
  })

  test('report: comments the outcome on the tracking issue and retitles it', async () => {
    const f = fakeFetch(V)
    const r = await watch.report({ agentKey: 'codex', version: '0.167.0', outcome: 'changed', issue: '77', diff: '### codex 0.167.0\n\n- not in known.ts: `turn_summary` ×3', fetchImpl: f.impl })
    assert.strictEqual(r.title, 'Codex 0.167.0 released: format change found')
    assert.match(r.body, /turn_summary/)
    assert.match(r.body, /AGENT_FORMAT_BREAK\.md/)
    assert.deepStrictEqual(f.calls.find(c => c.method === 'PATCH')!.body, { title: r.title })
    assert.strictEqual(((await watch.report({ agentKey: 'cursor', version: 'latest', outcome: 'skipped', issue: '5', fetchImpl: fakeFetch(V).impl })).title), 'Cursor CLI latest released: not captured (its secret is not set)')
    await assert.rejects(watch.report({ agentKey: 'codex', version: '1', outcome: 'meh', fetchImpl: f.impl }))
  })

  test('report: a new release nobody could capture is mailed; the nightly run\'s skip is not', () => {
    assert.strictEqual(watch.mailsOutcome('codex', 'skipped'), true)
    assert.strictEqual(watch.mailsOutcome('all', 'skipped'), false)
    assert.strictEqual(watch.mailsOutcome('all', 'changed'), true)
    assert.strictEqual(watch.mailsOutcome('codex', 'pass'), false)
  })
})

suite('fingerprint-diff — CI format check', () => {
  const FIXTURES = path.join(ROOT, 'src', 'test', 'fixtures', 'agents')
  let tmp: string
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-diff-')) })
  teardown(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const run = (newRoot: string) => new Promise<{ code: number; out: string }>(resolve => {
    execFile(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'fingerprint-diff.mjs'), newRoot, FIXTURES], (err, stdout) => {
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout })
    })
  })
  // The newest committed Codex fixture — what fingerprint-diff compares a capture with — as a
  // capture of a later version.
  const newestCodex = () => fs.readdirSync(path.join(FIXTURES, 'codex')).filter(v => /^\d/.test(v))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0] ?? 'synthetic'
  const copyCodex = () => {
    const dest = path.join(tmp, 'codex', '0.170.0')
    fs.cpSync(path.join(FIXTURES, 'codex', newestCodex()), dest, { recursive: true })
    const m = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'))
    fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ ...m, source: 'capture', agentVersion: '0.170.0' }))
    return path.join(dest, m.files[0].path)
  }

  test('an unchanged format passes', async () => {
    copyCodex()
    const r = await run(tmp)
    assert.strictEqual(r.code, 0, r.out)
    assert.match(r.out, /No format change/)
  })

  test('a new record type, or a key whose type changed everywhere, fails with a readable diff', async () => {
    const file = copyCodex()
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
    for (const l of lines) if (l['type'] === 'turn_context') (l['payload'] as Record<string, unknown>)['model'] = { id: 'gpt-5.1-codex' }
    lines.push({ timestamp: '2026-10-01T10:02:00.000Z', type: 'turn_summary', payload: { tokens: 5 } })
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    const r = await run(tmp)
    assert.strictEqual(r.code, 1)
    assert.match(r.out, /not in known\.ts: `turn_summary` ×1/)
    assert.match(r.out, /`turn_context` changed value types:\n\s+- `~ payload\.model: string → object`/)
  })

  const rewrite = (file: string, edit: (records: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
    fs.writeFileSync(file, edit(lines).map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  const isEvent = (r: Record<string, unknown>, t: string) => r['type'] === 'event_msg' && (r['payload'] as Record<string, unknown>)['type'] === t

  // Codex 0.167.0's failed capture: no prompt and no token counts — the parser finds no turn.
  test('a record the parser needs that the fixture had and the capture lacks fails', async () => {
    rewrite(copyCodex(), lines => lines.filter(l => !isEvent(l, 'item_completed') && !isEvent(l, 'token_count')))
    const r = await run(tmp)
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /no `event_msg:item_completed` record: TraceRoost reads `payload\.item` from it/)
    assert.match(r.out, /no `event_msg:token_count` record/)
  })

  // Copilot CLI 1.0.107's assistant.message dropping outputTokens, in this shape: a key known.ts
  // `reads` that the fixture's records carried. Its value is never looked at, only whether it's there.
  test('a key path known.ts reads that the fixture carried and the capture lacks fails', async () => {
    rewrite(copyCodex(), lines => lines.map(l => {
      if (!isEvent(l, 'token_count')) return l
      const info = (l['payload'] as Record<string, Record<string, Record<string, unknown>> | null>)['info']
      if (info?.['total_token_usage']) delete info['total_token_usage']['cached_input_tokens']
      return l
    }))
    const r = await run(tmp)
    assert.strictEqual(r.code, 1, r.out)
    assert.match(r.out, /`event_msg:token_count` no longer carries what TraceRoost reads from it: `payload\.info\.total_token_usage\.cached_input_tokens`/)
  })
})
