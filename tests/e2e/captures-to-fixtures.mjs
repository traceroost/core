#!/usr/bin/env node
// Turns a real-agent capture (the `e2e-real-agents-<os>` workflow artifact, or a local
// test-results/e2e/capture-real-agents*/ directory) into the committed adapter fixtures the
// contract suite reads (src/test/adapters.contract.test.ts):
//
//   node tests/e2e/captures-to-fixtures.mjs <capture dir> [--out src/test/fixtures/agents] [--os <os>]
//
// For each agent found in the capture it writes
//   <out>/<adapter>/<agent version>/files/<the file's path under the agent's home dir>
//   <out>/<adapter>/<agent version>/manifest.json
// with machine-specific values replaced by stable placeholders:
//   - the agent's sandbox repo (every transcript `cwd`) → <REPO>
//   - the capture's temp home directory, and any other home directory → <HOME>
//   - e-mail addresses → <EMAIL>
//   - anything that looks like an API key / bearer token → <REDACTED>
//   - an agent vendor's own system prompt (Copilot's system.message, Codex's base instructions)
//     → <SYSTEM PROMPT OMITTED>, and opaque per-call ids → <CALL-ID-n> (SCRUB below)
// Only the files TraceRoost reads are copied (`keep`): not an agent's lock files, checkpoints or
// workspace snapshots. It refuses (exit 1) if a home path, e-mail or token-shaped string survives. Then run
//   UPDATE_AGENT_FIXTURES=1 pnpm run test:unit
// to write each new version's expected.json, read the diff, and commit — see
// runbooks/AGENT_FORMAT_BREAK.md.
//
// Capture layout (written by real-agents.mjs and src/test/integration/realAgents.itest.ts):
//   claude-projects/            ~/.claude/projects
//   codex-sessions/             ~/.codex/sessions
//   copilot-session-state/      ~/.copilot/session-state
//   cursor-projects/            ~/.cursor/projects (agent-transcripts only)
//   opencode/opencode.db        ~/.local/share/opencode/opencode.db
//   versions.json               { "<adapter>": "<agent --version output>" }, when the run recorded it

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flagValue = n => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined)
const src = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
if (!src || !fs.existsSync(src)) {
  console.error('usage: node tests/e2e/captures-to-fixtures.mjs <capture dir> [--out src/test/fixtures/agents] [--os <os>]')
  process.exit(2)
}
const outRoot = path.resolve(flagValue('out') ?? path.join('src', 'test', 'fixtures', 'agents'))
const captureOs = flagValue('os') ?? (/(windows|macos|ubuntu)[^/\\]*/i.exec(path.resolve(src))?.[0] ?? null)

// capture subdirectory → adapter, LogReader key, where it sits under the home dir, which files count
// (`pick`, listed in the manifest) and which are copied (`keep`, default `pick`: Claude's subagent
// transcripts sit beside their parent and are read through it).
const SOURCES = [
  { dir: 'claude-projects',       adapter: 'claude',   logKey: 'claude',   home: '.claude/projects',         pick: f => f.endsWith('.jsonl') && !path.basename(f).startsWith('agent-'), keep: f => f.endsWith('.jsonl') },
  { dir: 'codex-sessions',        adapter: 'codex',    logKey: 'codex',    home: '.codex/sessions',          pick: f => f.endsWith('.jsonl') },
  { dir: 'copilot-session-state', adapter: 'copilot',  logKey: 'copilot',  home: '.copilot/session-state',   pick: f => path.basename(f) === 'events.jsonl' },
  { dir: 'cursor-projects',       adapter: 'cursor',   logKey: 'cursor',   home: '.cursor/projects',         pick: f => f.endsWith('.jsonl') && f.includes('agent-transcripts') },
  { dir: 'opencode',              adapter: 'opencode', logKey: 'opencode', home: '.local/share/opencode',    pick: f => path.basename(f) === 'opencode.db' },
]

// The version a record carries — the same fields as each adapter's known.ts versionOf.
const VERSION_OF = {
  claude:  r => r.version,
  codex:   r => (r.type === 'session_meta' ? r.payload?.cli_version : undefined),
  copilot: r => (r.type === 'session.start' ? r.data?.copilotVersion : undefined),
}

// Text no parser reads that isn't the user's to publish: the agent vendor's system prompt, and
// opaque per-call ids. Strings are replaced in place, so a record's fingerprint is unchanged.
const SYSTEM_PROMPT = '<SYSTEM PROMPT OMITTED>'
const CALL_ID_KEYS = new Set(['apiCallId', 'usageId', 'model_call_id'])
const replaceStrings = (v, s) => (typeof v === 'string' ? s : Array.isArray(v) ? v.map(x => replaceStrings(x, s)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceStrings(x, s)])) : v)
function scrubber() {
  const ids = new Map()
  const callIds = v => {
    if (Array.isArray(v)) return v.map(callIds)
    if (!v || typeof v !== 'object') return v
    return Object.fromEntries(Object.entries(v).map(([k, x]) => {
      if (CALL_ID_KEYS.has(k) && typeof x === 'string') {
        if (!ids.has(x)) ids.set(x, `<CALL-ID-${ids.size + 1}>`)
        return [k, ids.get(x)]
      }
      return [k, callIds(x)]
    }))
  }
  return {
    copilot: r => {
      if (r.type === 'system.message' && typeof r.data?.content === 'string') r = { ...r, data: { ...r.data, content: SYSTEM_PROMPT } }
      return callIds(r)
    },
    codex: r => {
      if (r.type !== 'session_meta' || !r.payload) return r
      const payload = { ...r.payload }
      for (const k of ['base_instructions', 'instructions']) if (k in payload) payload[k] = replaceStrings(payload[k], SYSTEM_PROMPT)
      return { ...r, payload }
    },
  }
}
function scrubJsonl(text, scrub) {
  if (!scrub) return text
  return text.split('\n').map(l => {
    if (!l.trim()) return l
    try { return JSON.stringify(scrub(JSON.parse(l))) } catch { return l }
  }).join('\n')
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}
const records = text => text.split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })

const versionsFile = path.join(src, 'versions.json')
const recordedVersions = fs.existsSync(versionsFile) ? JSON.parse(fs.readFileSync(versionsFile, 'utf8')) : {}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function spellings(p) {
  const fwd = p.replace(/\\/g, '/')
  const back = p.replace(/\//g, '\\')
  return [...new Set([p, fwd, back, back.replace(/\\/g, '\\\\'), fwd.replace(/\//g, '\\/')])]
}

// Every sandbox repo and home the capture names, longest first so a repo inside a home wins.
const cwds = new Set()
for (const s of SOURCES) {
  const dir = path.join(src, s.dir)
  if (!fs.existsSync(dir)) continue
  for (const f of walk(dir).filter(f => f.endsWith('.jsonl'))) {
    for (const r of records(fs.readFileSync(f, 'utf8'))) {
      for (const c of [r.cwd, r.payload?.cwd, r.data?.context?.cwd]) if (typeof c === 'string' && c) cwds.add(c)
    }
  }
}
const repos = [...cwds].sort((a, b) => b.length - a.length)
const homes = [...new Set(repos.map(r => path.dirname(r.replace(/\\/g, '/'))))]

function redact(text) {
  let t = text
  for (const r of repos) for (const s of spellings(r)) t = t.replace(new RegExp(escapeRe(s), 'gi'), '<REPO>')
  for (const h of homes) for (const s of spellings(h)) t = t.replace(new RegExp(escapeRe(s), 'gi'), '<HOME>')
  t = t.replace(/\/Users\/[^/"\\\s<]+|\/home\/[^/"\\\s<]+|[A-Za-z]:(\\\\|\\|\/)Users\1[^\\/"\s<]+/g, '<HOME>')
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>')
  t = t.replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '<REDACTED>')
  t = t.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/g, '$1<REDACTED>')
  return t
}

// Kept in step with the guard in src/test/adapters.contract.test.ts.
const LEFTOVER = /\/Users\/[^/<\s"]+|\/home\/[^/<\s"]+|[A-Za-z]:\\\\?Users\\\\?[^\\<\s"]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}/

let wrote = 0
const problems = []
for (const s of SOURCES) {
  const dir = path.join(src, s.dir)
  if (!fs.existsSync(dir)) continue
  const files = walk(dir).filter(s.pick)
  if (files.length === 0) continue

  let version = null
  for (const f of files.filter(f => f.endsWith('.jsonl'))) {
    for (const r of records(fs.readFileSync(f, 'utf8'))) version = VERSION_OF[s.adapter]?.(r) || version
  }
  const recorded = /\d+\.\d+[^\s)]*/.exec(String(recordedVersions[s.adapter] ?? ''))?.[0]
  // The contract test checks the manifest against the version the files themselves record; a
  // format that records none (Cursor, OpenCode) is filed under the CLI's --version output.
  const agentVersion = version ?? 'unknown'
  const dirName = version ?? recorded ?? 'unknown'
  const outDir = path.join(outRoot, s.adapter, dirName)
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true })

  const listed = []
  const scrub = scrubber()[s.adapter]
  for (const f of walk(dir).filter(s.keep ?? s.pick)) {
    const rel = path.join('files', s.home, path.relative(dir, f)).replace(/\\/g, '/')
    const dest = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (f.endsWith('.db')) fs.copyFileSync(f, dest)
    else {
      const raw = fs.readFileSync(f, 'utf8')
      const text = redact(f.endsWith('.jsonl') ? scrubJsonl(raw, scrub) : raw)
      fs.writeFileSync(dest, text)
      const m = LEFTOVER.exec(text)
      if (m) problems.push(`${path.relative(outRoot, dest)}: ${m[0]}`)
    }
    if (s.pick(f)) listed.push({ path: rel, logKey: s.logKey })
    wrote++
  }
  const manifest = {
    source: 'capture',
    captured: new Date().toISOString().slice(0, 10),
    os: captureOs,
    redaction: 'tests/e2e/captures-to-fixtures.mjs: <REPO>, <HOME>, <EMAIL>, <REDACTED>, <SYSTEM PROMPT OMITTED>, <CALL-ID-n>',
    adapter: s.adapter,
    agentVersion,
    ...(recorded && recorded !== version ? { cliVersion: recorded } : {}),
    files: listed,
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${s.adapter} ${dirName}: ${listed.length} file(s) → ${path.relative(process.cwd(), outDir)}`)
}

if (wrote === 0) {
  console.error(`no agent data under ${src} (expected ${SOURCES.map(s => s.dir).join(', ')})`)
  process.exit(1)
}
if (problems.length) {
  console.error(`unredacted values survived — fix the redaction before committing:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('next: UPDATE_AGENT_FIXTURES=1 pnpm run test:unit, review each expected.json, commit')
