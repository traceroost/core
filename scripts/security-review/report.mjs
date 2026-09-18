#!/usr/bin/env node
// Parses trivy/semgrep/pnpm-outdated JSON into one categorized markdown report + a counts summary.
// Used by .github/workflows/security-review.yml — see .staged-features/security-and-dependency-review.md.
import { readFileSync, writeFileSync } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

function readJson(path, fallback) {
  if (!path) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const repo = arg('repo', '')
const runUrl = arg('run-url', '')
const outPath = arg('out', 'security-review-report.md')
const countsPath = arg('counts', 'security-review-counts.json')

const trivy = readJson(arg('trivy'), {})
const semgrep = readJson(arg('semgrep'), {})
const outdated = readJson(arg('outdated'), {})

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']
// Copyleft licenses that need legal review before shipping in a closed-source product.
const DISALLOWED_LICENSES = new Set(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'CC-BY-NC-4.0'])

const vulns = []
const secrets = []
const misconfigs = []
const licenseFindings = []

for (const result of trivy.Results ?? []) {
  for (const v of result.Vulnerabilities ?? []) {
    vulns.push({
      severity: (v.Severity ?? 'UNKNOWN').toUpperCase(),
      pkg: v.PkgName,
      installed: v.InstalledVersion,
      fixed: v.FixedVersion || null,
      id: v.VulnerabilityID,
      title: v.Title,
      target: result.Target,
    })
  }
  for (const s of result.Secrets ?? []) {
    secrets.push({
      severity: (s.Severity ?? 'HIGH').toUpperCase(),
      rule: s.RuleID,
      title: s.Title,
      target: result.Target,
      line: s.StartLine,
    })
  }
  for (const m of result.Misconfigurations ?? []) {
    misconfigs.push({
      severity: (m.Severity ?? 'UNKNOWN').toUpperCase(),
      id: m.ID,
      title: m.Title,
      target: result.Target,
    })
  }
  for (const l of result.Licenses ?? []) {
    if (DISALLOWED_LICENSES.has(l.Name)) {
      licenseFindings.push({ pkg: l.PkgName, license: l.Name, target: result.Target })
    }
  }
}

const SEMGREP_SEVERITY_MAP = { ERROR: 'HIGH', WARNING: 'MEDIUM', INFO: 'LOW' }
const sast = (semgrep.results ?? []).map((r) => ({
  severity: SEMGREP_SEVERITY_MAP[r.extra?.severity] ?? 'MEDIUM',
  rule: r.check_id,
  message: (r.extra?.message ?? '').split('\n')[0],
  target: r.path,
  line: r.start?.line,
}))

function bumpKind(current, latest) {
  const c = String(current).split('.').map(Number)
  const l = String(latest).split('.').map(Number)
  if (Number.isNaN(c[0]) || Number.isNaN(l[0]) || l[0] > c[0]) return 'major'
  if (Number.isNaN(c[1]) || Number.isNaN(l[1]) || l[1] > c[1]) return 'minor'
  return 'patch'
}

const vulnPkgNames = new Set(vulns.map((v) => v.pkg))
const outdatedList = Object.entries(outdated)
  .filter(([, info]) => info && info.current !== info.latest)
  .map(([name, info]) => ({
    name,
    current: info.current,
    latest: info.latest,
    type: info.dependencyType,
    bump: bumpKind(info.current, info.latest),
    vulnerable: vulnPkgNames.has(name),
  }))
const bumpRank = { major: 0, minor: 1, patch: 2 }
outdatedList.sort((a, b) => {
  if (a.vulnerable !== b.vulnerable) return a.vulnerable ? -1 : 1
  return bumpRank[a.bump] - bumpRank[b.bump]
})

function bySeverity(items) {
  return SEVERITY_ORDER.reduce((acc, sev) => {
    acc[sev] = items.filter((i) => i.severity === sev)
    return acc
  }, {})
}

const vulnsBySev = bySeverity(vulns)
const sastBySev = bySeverity(sast)
const misconfigBySev = bySeverity(misconfigs)

const counts = {
  vulnerabilities: {
    critical: vulnsBySev.CRITICAL.length,
    high: vulnsBySev.HIGH.length,
    medium: vulnsBySev.MEDIUM.length,
    low: vulnsBySev.LOW.length,
  },
  secrets: secrets.length,
  misconfigurations: {
    critical: misconfigBySev.CRITICAL.length,
    high: misconfigBySev.HIGH.length,
    medium: misconfigBySev.MEDIUM.length,
    low: misconfigBySev.LOW.length,
  },
  sast: { high: sastBySev.HIGH.length, medium: sastBySev.MEDIUM.length, low: sastBySev.LOW.length },
  licenseRisks: licenseFindings.length,
  outdated: {
    total: outdatedList.length,
    vulnerable: outdatedList.filter((o) => o.vulnerable).length,
    major: outdatedList.filter((o) => o.bump === 'major').length,
  },
}
// What actually fails the scheduled run (a real, fixable risk right now) vs. what's
// just informational. Outdated-but-not-vulnerable and low/medium findings don't fail.
counts.shouldFail = counts.vulnerabilities.critical > 0 || counts.secrets > 0

const lines = []
lines.push(`# Security & dependency review${repo ? ` — ${repo}` : ''}`)
lines.push('')
lines.push(`Generated ${new Date().toISOString()}${runUrl ? ` · [workflow run](${runUrl})` : ''}`)
lines.push('')
lines.push('| Category | Critical | High | Medium | Low |')
lines.push('| --- | --- | --- | --- | --- |')
lines.push(
  `| 🔴 Dependency vulnerabilities | ${counts.vulnerabilities.critical} | ${counts.vulnerabilities.high} | ${counts.vulnerabilities.medium} | ${counts.vulnerabilities.low} |`,
)
lines.push(`| 🟠 Secrets detected | ${secrets.length} | — | — | — |`)
lines.push(
  `| 🟡 Misconfigurations | ${counts.misconfigurations.critical} | ${counts.misconfigurations.high} | ${counts.misconfigurations.medium} | ${counts.misconfigurations.low} |`,
)
lines.push(`| 🔵 Code-level findings (SAST) | — | ${counts.sast.high} | ${counts.sast.medium} | ${counts.sast.low} |`)
lines.push(`| ⚪ License risk | ${counts.licenseRisks} | — | — | — |`)
lines.push('')

function section(title, items, render) {
  if (items.length === 0) return
  lines.push(`## ${title} (${items.length})`)
  lines.push('')
  for (const item of items) lines.push(`- ${render(item)}`)
  lines.push('')
}

section('🔴 Critical & high dependency vulnerabilities', [...vulnsBySev.CRITICAL, ...vulnsBySev.HIGH], (v) =>
  `**${v.severity}** \`${v.pkg}@${v.installed}\` — ${v.title} (${v.id})${v.fixed ? ` → fix: \`${v.fixed}\`` : ''} — \`${v.target}\``,
)

section('🟠 Secrets detected', secrets, (s) => `**${s.severity}** \`${s.rule}\` in \`${s.target}:${s.line ?? '?'}\` — ${s.title}`)

section(
  '🟡 Misconfigurations',
  [...misconfigBySev.CRITICAL, ...misconfigBySev.HIGH, ...misconfigBySev.MEDIUM],
  (m) => `**${m.severity}** \`${m.id}\` — ${m.title} — \`${m.target}\``,
)

section(
  '🔵 Code-level findings (SAST)',
  [...sastBySev.HIGH, ...sastBySev.MEDIUM],
  (f) => `**${f.severity}** \`${f.rule}\` — ${f.message} — \`${f.target}:${f.line ?? '?'}\``,
)

section('⚪ License risk', licenseFindings, (l) => `\`${l.pkg}\` — ${l.license} — \`${l.target}\``)

if (outdatedList.length > 0) {
  lines.push(`## Dependencies to upgrade (${outdatedList.length})`)
  lines.push('')
  lines.push('| Package | Current | Latest | Bump | Vulnerable |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const o of outdatedList.slice(0, 50)) {
    lines.push(`| \`${o.name}\` | ${o.current} | ${o.latest} | ${o.bump} | ${o.vulnerable ? '⚠️ yes' : ''} |`)
  }
  if (outdatedList.length > 50) {
    lines.push('')
    lines.push(`_...and ${outdatedList.length - 50} more — see the workflow artifact for the full list._`)
  }
  lines.push('')
}

const totalFindings =
  vulns.length + secrets.length + misconfigs.length + sast.length + licenseFindings.length + outdatedList.length
if (totalFindings === 0) lines.push('No findings. ✅')

writeFileSync(outPath, lines.join('\n') + '\n')
writeFileSync(countsPath, JSON.stringify(counts, null, 2) + '\n')

console.log(`Wrote ${outPath} and ${countsPath}`)
console.log(JSON.stringify(counts, null, 2))
