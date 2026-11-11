#!/usr/bin/env node
// Agent release watch (.github/workflows/agent-release-watch.yml, every 6 h): notices a new
// release of an agent TraceRoost reads, before users do, and starts verifying it.
//
//   node scripts/agent-watch.mjs check <state.json> [--pretend-seen '<json>'] [--dry-run]
//     Looks up each agent's latest release (npm, the VS Code Marketplace, Cursor's install
//     script) and compares it with the versions in <state.json> (kept in the workflow's cache).
//     For each agent with a new release it opens — or retitles and comments on — its tracking
//     issue ("Codex 0.161.0 released: verification running", label agent-release), dispatches
//     agent-capture.yml pinned to that version, and mails the owners. The first run records a
//     baseline and mails it, so you know mail works. --pretend-seen overrides stored versions
//     (to exercise the path by hand); --dry-run changes nothing on GitHub and sends no mail.
//
//   node scripts/agent-watch.mjs report --agent <key> --version <v> --outcome <pass|changed|failed|skipped>
//                                       [--issue <n>] [--diff <markdown file>] [--dry-run]
//     Called by agent-capture.yml when its run ends: comments the result (and the fingerprint
//     diff) on the tracking issue, retitles it, and mails the owners when the format changed or
//     the run failed.
//
// It never commits, pushes or opens a pull request: a format change is a person's job
// (runbooks/AGENT_FORMAT_BREAK.md). Mail uses the same secrets as otel-watch (OTEL_WATCH_SMTP_*,
// OTEL_WATCH_MAIL_*); GitHub calls use GITHUB_TOKEN against GITHUB_API_URL / GITHUB_REPOSITORY.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mailConfigFromEnv, sendMail } from './otel-watch.mjs'

export const WATCHED = [
  { key: 'claude',         label: 'Claude Code',       source: { kind: 'npm', pkg: '@anthropic-ai/claude-code' }, capture: true },
  { key: 'codex',          label: 'Codex',             source: { kind: 'npm', pkg: '@openai/codex' },             capture: true },
  { key: 'opencode',       label: 'OpenCode',          source: { kind: 'npm', pkg: 'opencode-ai' },               capture: true },
  { key: 'copilot',        label: 'Copilot CLI',       source: { kind: 'npm', pkg: '@github/copilot' },           capture: true },
  // No headless mode: verified by hand (runbooks/AGENT_FORMAT_BREAK.md).
  { key: 'copilot_vscode', label: 'Copilot (VS Code)', source: { kind: 'marketplace', id: 'GitHub.copilot-chat' }, capture: false },
  { key: 'cursor',         label: 'Cursor CLI',        source: { kind: 'cursor-install', url: 'https://cursor.com/install' }, capture: true },
]

export const LABEL = 'agent-release'
const MAIL_AFTER_FAILURES = 4 // one day of 6-hourly runs

// ---------------------------------------------------------------------------------------------
// Latest versions

const registry = () => process.env.AGENT_WATCH_NPM_REGISTRY ?? 'https://registry.npmjs.org'
const marketplace = () => process.env.AGENT_WATCH_MARKETPLACE_URL ?? 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'

export async function latestVersion(source, fetchImpl = fetch) {
  if (source.kind === 'npm') {
    const r = await fetchImpl(`${registry()}/-/package/${source.pkg.replace('/', '%2f')}/dist-tags`)
    if (!r.ok) throw new Error(`npm ${source.pkg}: HTTP ${r.status}`)
    const tags = await r.json()
    if (typeof tags.latest !== 'string') throw new Error(`npm ${source.pkg}: no latest tag`)
    return tags.latest
  }
  if (source.kind === 'marketplace') {
    const r = await fetchImpl(marketplace(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json;api-version=3.0-preview.1' },
      // IncludeVersions | IncludeVersionProperties: pre-releases are told apart by a property.
      body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: source.id }] }], flags: 0x1 | 0x10 }),
    })
    if (!r.ok) throw new Error(`marketplace ${source.id}: HTTP ${r.status}`)
    const versions = (await r.json())?.results?.[0]?.extensions?.[0]?.versions ?? []
    const release = versions.find(v => !(v.properties ?? []).some(p => p.key === 'Microsoft.VisualStudio.Code.PreRelease' && p.value === 'true'))
    if (!release?.version) throw new Error(`marketplace ${source.id}: no release version`)
    return release.version
  }
  if (source.kind === 'cursor-install') {
    const r = await fetchImpl(process.env.AGENT_WATCH_CURSOR_URL ?? source.url)
    if (!r.ok) throw new Error(`cursor install script: HTTP ${r.status}`)
    const m = /downloads\.cursor\.com\/lab\/([0-9][^/"'\s]*)\//.exec(await r.text())
    if (!m) throw new Error('cursor install script: no version in the download URL')
    return m[1]
  }
  throw new Error(`unknown source kind ${source.kind}`)
}

// ---------------------------------------------------------------------------------------------
// GitHub

function gh(fetchImpl, dryRun) {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const repo = process.env.GITHUB_REPOSITORY
  const headers = { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
  const call = async (method, p, body) => {
    if (dryRun && method !== 'GET') { console.error(`[dry-run] ${method} ${p}`); return {} }
    const r = await fetchImpl(`${api}/repos/${repo}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
    if (!r.ok) throw new Error(`GitHub ${method} ${p}: HTTP ${r.status} ${await r.text()}`)
    return r.status === 204 ? {} : r.json()
  }
  return {
    enabled: !!repo,
    async trackingIssue(agent) {
      const open = await call('GET', `/issues?state=open&labels=${LABEL}&per_page=100`)
      return (Array.isArray(open) ? open : []).find(i => i.title.startsWith(`${agent.label} `)) ?? null
    },
    async upsertIssue(agent, title, body, comment) {
      const existing = await this.trackingIssue(agent)
      if (existing) {
        await call('PATCH', `/issues/${existing.number}`, { title })
        await call('POST', `/issues/${existing.number}/comments`, { body: comment })
        return existing.number
      }
      const created = await call('POST', '/issues', { title, body, labels: [LABEL] })
      return created.number
    },
    async comment(issue, title, body) {
      await call('PATCH', `/issues/${issue}`, { title })
      await call('POST', `/issues/${issue}/comments`, { body })
    },
    async dispatchCapture(agent, version, issue) {
      await call('POST', '/actions/workflows/agent-capture.yml/dispatches', { ref: process.env.AGENT_WATCH_REF ?? 'main', inputs: { agent: agent.key, version, issue: String(issue ?? '') } })
    },
  }
}

const runUrl = () => process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null

// ---------------------------------------------------------------------------------------------
// check

/** Agents whose capture the owners turned off (repo variable AGENT_CAPTURE_SKIP, e.g. `cursor`,
 *  comma- or space-separated) — no key for them, by choice. Their releases get a "check by hand"
 *  issue like Copilot Chat's, dispatch no capture, and don't mail on their own. */
export function captureSkipList(env = process.env) {
  return new Set(String(env.AGENT_CAPTURE_SKIP ?? '').split(/[\s,]+/).filter(Boolean))
}

export async function check({ statePath, pretendSeen = {}, dryRun = false, fetchImpl = fetch, mail = null, now = new Date(), skip = captureSkipList() }) {
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { version: 1, seen: {}, failures: {} }
  state.seen = { ...state.seen, ...pretendSeen }
  state.failures ??= {}
  const firstRun = Object.keys(state.seen).length === 0
  const github = gh(fetchImpl, dryRun)
  const lines = [`# Agent release watch: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`, '']
  const changes = [], errors = []

  for (const agent of WATCHED) {
    let latest
    try {
      latest = await latestVersion(agent.source, fetchImpl)
      state.failures[agent.key] = 0
    } catch (err) {
      state.failures[agent.key] = (state.failures[agent.key] ?? 0) + 1
      errors.push({ agent, error: String(err.message ?? err), streak: state.failures[agent.key] })
      lines.push(`- **${agent.label}**: could not check (${err.message ?? err}), ${state.failures[agent.key]} run(s) in a row`)
      continue
    }
    const prev = state.seen[agent.key]
    state.seen[agent.key] = latest
    if (!prev) { lines.push(`- **${agent.label}**: ${latest} (baseline)`); continue }
    if (prev === latest) { lines.push(`- ${agent.label}: ${latest}`); continue }
    changes.push({ agent, from: prev, to: latest })
    lines.push(`- **${agent.label}: ${prev} → ${latest}**`)
  }

  const captured = agent => agent.capture && !skip.has(agent.key)
  for (const c of changes) {
    const verifying = captured(c.agent)
    const title = `${c.agent.label} ${c.to} released: ${verifying ? 'verification running' : 'check by hand'}`
    const body = [
      `${c.agent.label} ${c.to} was released (previously ${c.from}).`,
      '',
      verifying
        ? 'The agent-capture workflow is running it headless and diffing what it writes against the committed fixtures. Its result is commented here.'
        : c.agent.capture
        ? 'Capture is turned off for this agent (repo variable AGENT_CAPTURE_SKIP), so it is not checked in CI. Check it by hand: runbooks/AGENT_FORMAT_BREAK.md.'
        : 'This agent has no headless mode, so it is not captured in CI. Check it by hand: runbooks/AGENT_FORMAT_BREAK.md.',
      '',
      ...(runUrl() ? [`Release watch run: ${runUrl()}`, ''] : []),
      '_Opened by scripts/agent-watch.mjs. It never changes code; a format change is fixed by hand._',
    ].join('\n')
    if (github.enabled) {
      c.issue = await github.upsertIssue(c.agent, title, body, body)
      if (verifying) await github.dispatchCapture(c.agent, c.to, c.issue)
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true })
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')

  const stuck = errors.filter(e => e.streak === MAIL_AFTER_FAILURES)
  let subject = null
  if (firstRun) subject = 'TraceRoost agent release watch: baseline recorded'
  // An agent whose capture was turned off doesn't mail on its own: it is listed when another
  // release mails.
  else if (changes.some(c => !skip.has(c.agent.key))) subject = `TraceRoost: new agent release (${changes.map(c => `${c.agent.label} ${c.to}`).join(', ')})`
  else if (stuck.length) subject = `TraceRoost agent release watch: could not check ${stuck.map(e => e.agent.label).join(', ')} for a day`
  if (changes.length) {
    const what = c => (!captured(c.agent) ? 'check by hand' : github.enabled && !dryRun ? 'verification dispatched' : 'verification not dispatched (no GitHub repository, or --dry-run)')
    lines.push('', ...changes.map(c => `${c.agent.label} ${c.to}: ${what(c)}${c.issue ? ` (issue #${c.issue})` : ''}`))
  }
  const text = lines.join('\n')
  let mailed = false
  if (subject && mail && !dryRun) { await sendMail({ ...mail, subject, text }); mailed = true }
  return { text, changes, errors, firstRun, mailed, subject }
}

// ---------------------------------------------------------------------------------------------
// report

/** Who hears about a capture's outcome by mail: a format change or a run that broke, always; a
 *  new release nobody could capture (its secret isn't set), too — that release went unchecked.
 *  The nightly run of every agent doesn't mail a skip: it fails the job instead (agent-capture.yml),
 *  rather than a mail every night until the secrets are set. */
export function mailsOutcome(agentKey, outcome) {
  return outcome === 'changed' || outcome === 'failed' || (outcome === 'skipped' && agentKey !== 'all')
}

export async function report({ agentKey, version, outcome, issue, diff = '', dryRun = false, fetchImpl = fetch, mail = null }) {
  // `all`: the nightly capture of every agent's latest release, which has no tracking issue.
  const agent = agentKey === 'all' ? { key: 'all', label: 'Nightly agent capture' } : WATCHED.find(a => a.key === agentKey)
  if (!agent) throw new Error(`unknown agent ${agentKey}`)
  const verdict = { pass: 'verified, no format change', changed: 'format change found', failed: 'verification failed to run', skipped: 'not captured (its secret is not set)' }[outcome]
  if (!verdict) throw new Error(`unknown outcome ${outcome}`)
  const title = agent.key === 'all' ? `${agent.label}: ${verdict}` : `${agent.label} ${version} released: ${verdict}`
  const body = [
    `**${verdict[0].toUpperCase()}${verdict.slice(1)}.**`,
    '',
    ...(diff.trim() ? [diff.trim(), ''] : []),
    ...(runUrl() ? [`Capture run (captures and the fingerprint diff are its artifacts): ${runUrl()}`, ''] : []),
    outcome === 'pass'
      ? 'Nothing to do; close this issue, or leave it for the next release to retitle.'
      : outcome === 'skipped'
      ? 'Add the agent\'s secret (see .github/workflows/agent-capture.yml), or check it by hand: runbooks/AGENT_FORMAT_BREAK.md.'
      : 'Next: runbooks/AGENT_FORMAT_BREAK.md. Commit the capture as a fixture, let the failing contract test be the spec.',
  ].join('\n')
  const github = gh(fetchImpl, dryRun)
  if (github.enabled && issue) await github.comment(issue, title, body)
  let mailed = false
  if (mailsOutcome(agent.key, outcome) && mail && !dryRun) {
    await sendMail({ ...mail, subject: `TraceRoost: ${title}`, text: `${title}\n\n${body}` })
    mailed = true
  }
  return { title, body, mailed }
}

// ---------------------------------------------------------------------------------------------
// Main

async function main() {
  const [mode, ...args] = process.argv.slice(2)
  const flag = n => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined)
  const dryRun = args.includes('--dry-run')
  const mail = dryRun ? null : mailConfigFromEnv(process.env)
  if (mode === 'check' && args[0] && !args[0].startsWith('--')) {
    const result = await check({ statePath: args[0], pretendSeen: flag('pretend-seen') ? JSON.parse(flag('pretend-seen')) : {}, dryRun, mail })
    process.stdout.write(result.text + '\n')
    console.error(`changes=${result.changes.length} errors=${result.errors.length} mailed=${result.mailed}${!dryRun && !mail ? ' (mail not configured)' : ''}`)
    return
  }
  if (mode === 'report' && flag('agent') && flag('version') && flag('outcome')) {
    const diffFile = flag('diff')
    const diff = diffFile && fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : ''
    const result = await report({ agentKey: flag('agent'), version: flag('version'), outcome: flag('outcome'), issue: flag('issue') || undefined, diff, dryRun, mail })
    process.stdout.write(`${result.title}\n\n${result.body}\n`)
    return
  }
  console.error('usage: node scripts/agent-watch.mjs check <state.json> [--pretend-seen <json>] [--dry-run]\n' +
    '       node scripts/agent-watch.mjs report --agent <key> --version <v> --outcome <pass|changed|failed|skipped> [--issue <n>] [--diff <file>] [--dry-run]')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1) })
}
