#!/usr/bin/env node
// Compares what a new real-agent capture writes with the committed adapter fixtures, so a format
// change fails CI with a readable diff instead of reaching users as wrong numbers.
//
//   pnpm run compile-tests
//   node tests/e2e/fingerprint-diff.mjs <new fixtures root> [<committed root>] [--out diff.md]
//
// <new fixtures root> is captures-to-fixtures.mjs output (<agent>/<version>/manifest.json + files);
// <committed root> defaults to src/test/fixtures/agents. Classification and fingerprints come from
// the compiled src/adapters (out/test/adapters), the same code the product runs.
//
// Fails (exit 1) when the capture has, against the newest committed fixture of that agent,
//   - a record the adapter's known.ts doesn't know (a new record type or event name), or a record
//     it reads missing a required key,
//   - a key whose value type changed,
//   - no record of a name the adapter reads with required keys (known.ts `consumed`) that the
//     fixture had — the agent stopped writing the prompt or the token counts, say — or
//   - records of a name that no longer carry a key path known.ts `reads` lists and the fixture's
//     did (only whether a path is there is looked at, never its value).
// Reported but not failing: other keys added or not seen (a capture doesn't exercise every path),
// and other record names seen on only one side. OpenCode captures are a database: checked by the contract
// suite once committed, not here.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const load = m => {
  try { return require(path.join(ROOT, 'out', 'test', 'adapters', m)) } catch (err) {
    console.error(`could not load out/test/adapters/${m} — run \`pnpm run compile-tests\` first (${err.message})`)
    process.exit(2)
  }
}
const { RECORDS_BY_LOG_KEY, classifyRecord, atPath } = load('classify.js')
const { fingerprint, mergeFingerprints, diffFingerprints } = load('fingerprint.js')
const { compareVersions } = load('health.js')

const argv = process.argv.slice(2)
const flag = n => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined)
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
const [newRoot, committedRoot = path.join(ROOT, 'src', 'test', 'fixtures', 'agents')] = positional
if (!newRoot || !fs.existsSync(newRoot)) {
  console.error('usage: node tests/e2e/fingerprint-diff.mjs <new fixtures root> [<committed root>] [--out diff.md]')
  process.exit(2)
}

const dirsOf = root => (fs.existsSync(root) ? fs.readdirSync(root) : []).flatMap(agent =>
  fs.readdirSync(path.join(root, agent)).filter(v => fs.existsSync(path.join(root, agent, v, 'manifest.json')))
    .map(version => ({ agent, version, dir: path.join(root, agent, version), manifest: JSON.parse(fs.readFileSync(path.join(root, agent, version, 'manifest.json'), 'utf8')) })))

/** name → { count, fingerprint (merged), unknown classification name if any, the `reads` paths
 *  any record of the name carried, its known.ts } for one fixture. */
function profile(fx) {
  const names = new Map()
  for (const file of fx.manifest.files) {
    const known = RECORDS_BY_LOG_KEY[file.logKey]
    if (!known || file.logKey === 'opencode') continue
    const text = fs.readFileSync(path.join(fx.dir, file.path), 'utf8')
    const records = file.path.endsWith('.jsonl') ? text.split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } }) : [JSON.parse(text)]
    for (const r of records) {
      const c = classifyRecord(known, r)
      const key = c.cls === 'unknown' ? `unknown:${c.name}` : c.name
      const prev = names.get(key) ?? { count: 0, fp: undefined, cls: c.cls, name: c.name, reads: new Set(), known }
      prev.count++
      prev.fp = mergeFingerprints(prev.fp, fingerprint(r, known))
      for (const p of known.reads?.[c.name] ?? []) if (atPath(r, p) !== undefined && atPath(r, p) !== null) prev.reads.add(p)
      names.set(key, prev)
    }
  }
  return names
}

const committed = dirsOf(committedRoot)
const lines = ['## Agent format check', '']
let failed = false
for (const fx of dirsOf(newRoot)) {
  const head = `### ${fx.agent} ${fx.version}`
  if (fx.agent === 'opencode') { lines.push(head, '', 'OpenCode writes a database: no structural diff here; the contract suite checks it once the capture is committed.', ''); continue }
  const baseline = committed.filter(c => c.agent === fx.agent).sort((a, b) => compareVersions(b.manifest.agentVersion, a.manifest.agentVersion) || (a.manifest.source === 'capture' ? -1 : 1))[0]
  const now = profile(fx)
  const before = baseline ? profile(baseline) : new Map()
  const fail = [], info = []
  for (const [key, p] of now) {
    if (p.cls === 'unknown') { fail.push(`- not in known.ts: \`${p.name}\` ×${p.count}\n\n  \`\`\`json\n  ${JSON.stringify(p.fp)}\n  \`\`\``); continue }
    const b = before.get(key)
    if (!b) { info.push(`- first seen in a capture: \`${key}\` ×${p.count}`); continue }
    const d = diffFingerprints(b.fp, p.fp)
    // A retype is a key whose old and new types have nothing in common (number → string). One
    // that only gained or lost a type (number → null|number) is a path this capture did or didn't
    // exercise, and only reported.
    const disjoint = l => {
      const m = /^~ .*: (\S+) → (\S+)$/.exec(l)
      if (!m) return false
      const before = new Set(m[1].split('|'))
      return !m[2].split('|').some(t => before.has(t))
    }
    const retyped = d.filter(disjoint)
    if (retyped.length) fail.push(`- \`${key}\` changed value types:\n${retyped.map(l => `  - \`${l}\``).join('\n')}`)
    const gone = [...b.reads].filter(path => !p.reads.has(path))
    if (gone.length) fail.push(`- \`${key}\` no longer carries what TraceRoost reads from it: ${gone.map(g => `\`${g}\``).join(', ')}`)
    const other = d.filter(l => !disjoint(l))
    if (other.length) info.push(`- \`${key}\`: ${other.map(l => `\`${l}\``).join(', ')}`)
  }
  for (const [key, b] of before) {
    if (now.has(key)) continue
    const required = b.cls === 'known' ? b.known.consumed[key] : undefined
    if (required?.length) fail.push(`- no \`${key}\` record: TraceRoost reads ${required.map(r => `\`${r}\``).join(', ')} from it, and the committed fixture had ${b.count}`)
    else info.push(`- not in this capture: \`${key}\``)
  }
  lines.push(head, '', `Compared with ${baseline ? `${baseline.agent} ${baseline.version} (${baseline.manifest.source})` : 'nothing committed yet'}.`, '')
  if (fail.length) { failed = true; lines.push('**Format change — fails the check:**', '', ...fail, '') }
  else lines.push('No format change: every record is known and no value type changed.', '')
  if (info.length) lines.push('<details><summary>Other differences (not failing)</summary>', '', ...info, '', '</details>', '')
}
const text = lines.join('\n')
if (flag('out')) fs.writeFileSync(flag('out'), text + '\n')
process.stdout.write(text + '\n')
process.exit(failed ? 1 : 0)
