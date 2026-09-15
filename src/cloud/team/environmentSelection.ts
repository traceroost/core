/**
 * Persisted environment selection for an *unlinked* install (AL 01).
 *
 * Lets the Team panel's environment picker survive restarts without needing a shell env var or
 * `.env` file. Only ever consulted by `resolveTeamEnvironment()` in `config.ts`, and only when
 * neither `TRACEROOST_TEAM_URL` nor `TRACEROOST_TEAM_ENV` is set — a linked machine never reads
 * this file, since every call site uses the endpoint baked into its credential instead (AL 02).
 */

import * as fs from 'fs'
import * as path from 'path'
import { traceroostDir } from './credentials'
import { isTeamEnvironment, type TeamEnvironment } from './config'

function selectionPath(baseHome?: string): string {
  return path.join(traceroostDir(baseHome), 'team-env.json')
}

/** Returns the persisted selection, or `null` if none was ever made (or the file is missing or
 *  unreadable — treated the same as "no selection", never thrown). */
export function loadSelectedEnvironment(baseHome?: string): TeamEnvironment | null {
  try {
    const raw = fs.readFileSync(selectionPath(baseHome), 'utf-8')
    const parsed = JSON.parse(raw) as { environment?: string }
    if (typeof parsed.environment === 'string' && isTeamEnvironment(parsed.environment)) {
      return parsed.environment
    }
    return null
  } catch {
    return null
  }
}

export function saveSelectedEnvironment(env: TeamEnvironment, baseHome?: string): void {
  const file = selectionPath(baseHome)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ environment: env }, null, 2) + '\n')
}

export function clearSelectedEnvironment(baseHome?: string): void {
  try {
    fs.rmSync(selectionPath(baseHome), { force: true })
  } catch {
    /* already gone — leaving is idempotent by design */
  }
}
