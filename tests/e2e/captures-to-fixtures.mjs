#!/usr/bin/env node
// Turns a real-agent capture (the `e2e-real-agents-<os>` workflow artifact, or a local
// test-results/e2e/capture-real-agents/ directory) into committed, redacted test fixtures:
//
//   node tests/e2e/captures-to-fixtures.mjs <capture dir> [--name <fixture name>] [--out tests/e2e/fixtures/real]
//
// For each agent transcript (Claude Code ~/.claude/projects/**.jsonl, Codex ~/.codex/sessions/**.jsonl)
// and each exported OTEL span file (otel-export_*.json) it writes a copy under
// <out>/<name>/ with machine-specific values replaced by stable placeholders:
//   - the temp home directory → <HOME> (both `\` and `/` spellings, and JSON-escaped `\\`)
//   - the agent's sandbox repo → <REPO>
//   - anything that looks like an API key / bearer token → <REDACTED>
// plus a manifest.json (source OS, agent CLI versions if recorded, file list). The placeholders
// are what a replay test substitutes back (e.g. with lib.mjs's makeTempHome/makeGitRepo paths).

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const src = argv.find(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--name' && argv[argv.indexOf(a) - 1] !== '--out')
if (!src || !fs.existsSync(src)) {
  console.error('usage: node tests/e2e/captures-to-fixtures.mjs <capture dir> [--name <name>] [--out <dir>]')
  process.exit(2)
}
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d)
const name = opt('name', `${path.basename(path.resolve(src))}-${new Date().toISOString().slice(0, 10)}`)
const outDir = path.resolve(opt('out', path.join('tests', 'e2e', 'fixtures', 'real')), name)

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
}

const files = walk(src)
const transcripts = files.filter(f => f.endsWith('.jsonl'))
const otel = files.filter(f => /otel-.*\.json$/.test(path.basename(f)))
if (transcripts.length + otel.length === 0) {
  console.error(`no transcripts (*.jsonl) or exported spans (otel-*.json) under ${src}`)
  process.exit(1)
}

// Discover the capture's home and repo paths from the transcripts themselves (their `cwd`).
const cwds = new Set()
for (const f of transcripts) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line)
      const cwd = o.cwd ?? o.payload?.cwd
      if (typeof cwd === 'string') cwds.add(cwd)
    } catch { /* partial line */ }
  }
}
const repos = [...cwds].sort((a, b) => b.length - a.length)
const homes = [...new Set(repos.map(r => path.dirname(r.replace(/\\/g, '/'))))]

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function spellings(p) {
  const fwd = p.replace(/\\/g, '/')
  const back = p.replace(/\//g, '\\')
  return [...new Set([p, fwd, back, back.replace(/\\/g, '\\\\'), fwd.replace(/\//g, '\\/')])]
}
function redact(text) {
  let t = text
  for (const r of repos) for (const s of spellings(r)) t = t.replace(new RegExp(escapeRe(s), 'gi'), '<REPO>')
  for (const h of homes) for (const s of spellings(h)) t = t.replace(new RegExp(escapeRe(s), 'gi'), '<HOME>')
  t = t.replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,})\b/g, '<REDACTED>')
  t = t.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/g, '$1<REDACTED>')
  return t
}

fs.mkdirSync(outDir, { recursive: true })
const written = []
for (const f of [...transcripts, ...otel]) {
  const agent = /claude-projects/.test(f) ? 'claude' : /codex-sessions/.test(f) ? 'codex' : 'otel'
  const dest = path.join(outDir, agent, path.basename(f))
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, redact(fs.readFileSync(f, 'utf8')))
  written.push(path.relative(outDir, dest).replace(/\\/g, '/'))
}
const manifest = {
  name,
  source: path.resolve(src),
  convertedAt: new Date().toISOString(),
  placeholders: { '<HOME>': 'the capture run\'s temp home directory', '<REPO>': 'the agent\'s sandbox git repo' },
  files: written,
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const leftovers = written.filter(w => /[A-Za-z]:\\\\Users|\/Users\/runner|\/home\/runner|traceroost-vscode-/.test(fs.readFileSync(path.join(outDir, w), 'utf8')))
console.log(`wrote ${written.length} fixture files to ${outDir}`)
if (leftovers.length) console.log(`check these for unredacted machine paths before committing: ${leftovers.join(', ')}`)
