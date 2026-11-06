/**
 * The one list of agents TraceRoost reads: labels, where their data comes from, how well each is
 * tested and the last agent version a committed real capture verified. The standalone server's
 * startup line, the extension's, adapter health (health.ts), `traceroost doctor` and the README
 * support matrix all read it; a new agent starts here.
 */

import type { AdapterKey, SourceKind, SupportLevel } from './types'

export interface AgentAdapter {
  key: AdapterKey
  label: string
  /** LogReader agent keys that belong to this adapter (Copilot Chat has two file formats). */
  logKeys: readonly string[]
  /** Where its local data lives, for log lines and doctor output. */
  dataDir: string
  sources: readonly SourceKind[]
  support: SupportLevel
  /** The newest agent version a committed real capture (src/test/fixtures/agents/) verified, or
   *  null while no real capture is committed. Bumped by the break-fix runbook. */
  lastVerifiedVersion: string | null
}

export const ADAPTERS: readonly AgentAdapter[] = [
  { key: 'claude',         label: 'Claude Code',       logKeys: ['claude'],                                dataDir: '~/.claude/projects/',             sources: ['otlp', 'files'],   support: 'verified',       lastVerifiedVersion: null },
  { key: 'codex',          label: 'Codex',             logKeys: ['codex'],                                 dataDir: '~/.codex/sessions/',              sources: ['otlp', 'files'],   support: 'verified',       lastVerifiedVersion: null },
  { key: 'copilot',        label: 'Copilot CLI',       logKeys: ['copilot'],                               dataDir: '~/.copilot/session-state/',       sources: ['otlp', 'files'],   support: 'fixture-tested', lastVerifiedVersion: null },
  { key: 'copilot_vscode', label: 'Copilot (VS Code)', logKeys: ['copilot_vscode', 'copilot_vscode_json'], dataDir: '~/Library/…/workspaceStorage/',  sources: ['otlp', 'files'],   support: 'best-effort',    lastVerifiedVersion: null },
  { key: 'opencode',       label: 'OpenCode',          logKeys: ['opencode'],                              dataDir: '~/.local/share/opencode/',        sources: ['sqlite'],          support: 'fixture-tested', lastVerifiedVersion: null },
  { key: 'cursor',         label: 'Cursor CLI',        logKeys: ['cursor'],                                dataDir: '~/.cursor/projects/',             sources: ['files'],           support: 'fixture-tested', lastVerifiedVersion: null },
]

const BY_KEY = new Map<string, AgentAdapter>(ADAPTERS.map(a => [a.key, a]))
const BY_LOG_KEY = new Map<string, AgentAdapter>(ADAPTERS.flatMap(a => a.logKeys.map(k => [k, a] as const)))

export function adapterFor(key: string): AgentAdapter | undefined { return BY_KEY.get(key) }

/** The adapter a LogReader agent key belongs to. */
export function adapterForLogKey(logKey: string): AgentAdapter | undefined { return BY_LOG_KEY.get(logKey) }

/** Display name for a LogReader agent key ('copilot_vscode_json' → 'Copilot (VS Code)'). */
export function agentKeyLabel(logKey: string): string { return adapterForLogKey(logKey)?.label ?? logKey }

/** Where a LogReader agent key's files live. */
export function agentKeyDir(logKey: string): string { return adapterForLogKey(logKey)?.dataDir ?? logKey }

const SUPPORT_LABEL: Record<SupportLevel, string> = {
  'verified': 'Verified',
  'fixture-tested': 'Fixture-tested',
  'best-effort': 'Best effort',
}

const SOURCE_LABEL: Record<SourceKind, string> = { otlp: 'OTel', files: 'log files', sqlite: 'SQLite database' }

/** The README's support matrix (between its support-matrix markers), generated from ADAPTERS —
 *  adapters.classify.test.ts fails when the README's copy drifts. */
export function supportMatrixMarkdown(): string {
  return [
    '| Agent | Reads | Support level | Last verified version |',
    '|---|---|---|---|',
    ...ADAPTERS.map(a => `| ${a.label} | ${a.sources.map(s => SOURCE_LABEL[s]).join(', ')} | ${SUPPORT_LABEL[a.support]} | ${a.lastVerifiedVersion ?? 'none yet'} |`),
  ].join('\n')
}
