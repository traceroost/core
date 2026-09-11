/**
 * A small local record of applied / dismissed / reverted Advisor suggestions (AL 08), for the
 * CLI apply loop. The VS Code extension keeps the authoritative record in SQLite
 * (`instruction_applied` / `instruction_dismissed`); this file is the CLI's equivalent so
 * `agentlens advise --apply` outside the editor still captures a baseline and can emit events.
 *
 * `~/.agentlens/instruction-ledger.json`, keyed by workspace path.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SuggestionLedger } from './instructionTelemetry'
import { EMPTY_LEDGER } from './instructionTelemetry'

function ledgerPath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.agentlens', 'instruction-ledger.json')
}

type LedgerFile = Record<string, SuggestionLedger>

function readFile(baseHome?: string): LedgerFile {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(baseHome), 'utf-8')) as LedgerFile
  } catch {
    return {}
  }
}

function writeFile(data: LedgerFile, baseHome?: string): void {
  const file = ledgerPath(baseHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

export function readLedger(workspace: string, baseHome?: string): SuggestionLedger {
  return readFile(baseHome)[workspace] ?? { ...EMPTY_LEDGER, applied: [], dismissed: [], reverted: [] }
}

export function recordApplied(workspace: string, id: string, card?: SuggestionLedger['applied'][number]['card'], baseHome?: string): void {
  const data = readFile(baseHome)
  const l = data[workspace] ?? { applied: [], dismissed: [], reverted: [] }
  if (!l.applied.some(a => a.id === id)) l.applied.push({ id, atIso: new Date().toISOString(), card })
  data[workspace] = l
  writeFile(data, baseHome)
}

export function recordDismissed(workspace: string, id: string, baseHome?: string): void {
  const data = readFile(baseHome)
  const l = data[workspace] ?? { applied: [], dismissed: [], reverted: [] }
  if (!l.dismissed.some(d => d.id === id)) l.dismissed.push({ id, atIso: new Date().toISOString() })
  data[workspace] = l
  writeFile(data, baseHome)
}

export function recordReverted(workspace: string, id: string, baseHome?: string): void {
  const data = readFile(baseHome)
  const l = data[workspace] ?? { applied: [], dismissed: [], reverted: [] }
  l.applied = l.applied.filter(a => a.id !== id)
  if (!l.reverted.some(r => r.id === id)) l.reverted.push({ id, atIso: new Date().toISOString() })
  data[workspace] = l
  writeFile(data, baseHome)
}
