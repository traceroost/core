/**
 * Reads the plan-usage reading Claude Code caches for itself in its global config file.
 *
 * Location: `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set and non-empty, otherwise
 * `~/.claude.json` — next to `~/.claude/`, not inside it. Only two keys are ever read:
 * `oauthAccount.accountUuid` and `cachedUsageUtilization`. The file also holds the user's email
 * address and project history; nothing else in it is read, returned, stored or logged.
 *
 * This is an undocumented cache, so every failure — missing file, oversized file, bad JSON, a
 * missing key, an account mismatch, an unexpected shape — is "no reading" (null), never an error.
 * No credential is read and no network call is made.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import type { LimitReading, LimitWindowKind } from './limitReadings'

/** The file is normally under 1 MB; it grows with use, so the read is capped defensively. */
const MAX_CONFIG_BYTES = 10 * 1024 * 1024

const WINDOW_KEYS: Array<[string, LimitWindowKind]> = [
  ['five_hour', 'five_hour'],
  ['seven_day', 'weekly'],
  ['seven_day_opus', 'weekly_opus'],
  ['seven_day_sonnet', 'weekly_sonnet'],
]

/** `limits[].kind` values used as a fallback if the named window keys ever disappear. */
const LIMIT_KIND_TO_WINDOW: Record<string, LimitWindowKind> = {
  session: 'five_hour',
  weekly_all: 'weekly',
}

export interface ClaudeCachedUsage {
  /** Salted hash of the account id — only used to tell whether readings belong to one account. */
  accountHash: string
  /** Epoch ms — when Claude Code fetched this reading, not when it was read from disk. */
  fetchedAt: number
  readings: LimitReading[]
}

export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const dir = env['CLAUDE_CONFIG_DIR']
  return dir && dir.trim() ? path.join(dir, '.claude.json') : path.join(home, '.claude.json')
}

function hashAccountId(accountId: string): string {
  return createHash('sha256').update(`traceroost-plan-usage:${accountId}`).digest('hex').slice(0, 16)
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function pct(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined
}

function isoMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : undefined
}

/** Pure parse of the config file's JSON text — exported for tests. */
export function parseClaudeCachedUsage(text: string): ClaudeCachedUsage | null {
  let root: Record<string, unknown> | undefined
  try { root = obj(JSON.parse(text)) } catch { return null }
  if (!root) return null

  const signedIn = obj(root['oauthAccount'])?.['accountUuid']
  const cache = obj(root['cachedUsageUtilization'])
  if (!cache || typeof signedIn !== 'string' || !signedIn) return null
  if (cache['accountUuid'] !== signedIn) return null
  const fetchedAt = cache['fetchedAtMs']
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return null
  const utilization = obj(cache['utilization'])
  if (!utilization) return null

  const readings: LimitReading[] = []
  const reading = (windowKind: LimitWindowKind, usedPct: number, resetsAt: number | undefined): LimitReading => ({
    provider: 'claude', windowKind, usedPct, resetsAt, observedAt: fetchedAt, source: 'claude_cache',
  })
  for (const [key, windowKind] of WINDOW_KEYS) {
    const w = obj(utilization[key])
    const used = pct(w?.['utilization'])
    if (w && used !== undefined) readings.push(reading(windowKind, used, isoMs(w['resets_at'])))
  }
  if (readings.length === 0 && Array.isArray(utilization['limits'])) {
    for (const item of utilization['limits'] as unknown[]) {
      const l = obj(item)
      const windowKind = typeof l?.['kind'] === 'string' ? LIMIT_KIND_TO_WINDOW[l['kind']] : undefined
      const used = pct(l?.['percent'])
      if (l && windowKind && used !== undefined) readings.push(reading(windowKind, used, isoMs(l['resets_at'])))
    }
  }
  if (readings.length === 0) return null
  return { accountHash: hashAccountId(signedIn), fetchedAt, readings }
}

/**
 * Reads the cache from disk. `lastMtimeMs`, when given, skips the parse if the file hasn't been
 * modified since — the caller polls this on every log scan.
 */
export function readClaudeCachedUsage(
  filePath = claudeConfigPath(),
  lastMtimeMs?: number,
): { usage: ClaudeCachedUsage | null; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null
    if (lastMtimeMs !== undefined && stat.mtimeMs === lastMtimeMs) return { usage: null, mtimeMs: stat.mtimeMs }
    return { usage: parseClaudeCachedUsage(fs.readFileSync(filePath, 'utf8')), mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}
