/**
 * Remove agent setup, shared by every surface that offers it — VS Code's "TraceRoost: Remove Agent
 * Setup…" command, `traceroost agents remove`, and the dashboard's Remove agent setup button
 * (POST /action { type: 'removeAgentSetup' } on the standalone server). Runs the per-agent strip
 * functions (src/autoConfigNode.ts) and words the outcome the same way everywhere. Recording the
 * answer ('no', so nothing sets the agents up again) is left to the caller, after a real run.
 */

import * as os from 'os'
import * as path from 'path'
import { removeClaudeCodeSetup, removeCodexSetup, removeCopilotStandaloneSetup, type RemoveOptions, type RemoveResult } from './autoConfigNode'

export type AgentName = 'Claude Code' | 'Codex' | 'Copilot'

/** One settings file's outcome. `file` is a path, or a label such as "your VS Code user
 *  settings" when the change went through the editor's settings API. */
export interface AgentRemoval extends RemoveResult {
  agent: AgentName
}

/** Claude Code, Codex, and Copilot in every installed VS Code-family IDE's settings file. */
export async function removeAgentSetupFiles(opts: RemoveOptions = {}): Promise<AgentRemoval[]> {
  const [claude, codex, copilot] = await Promise.all([
    removeClaudeCodeSetup(opts),
    removeCodexSetup(opts),
    removeCopilotStandaloneSetup(opts),
  ])
  return [
    { agent: 'Claude Code', ...claude },
    { agent: 'Codex', ...codex },
    ...copilot.map(r => ({ agent: 'Copilot' as const, ...r })),
  ]
}

/** `~/…` for a path under the home directory, so messages stay short. */
export function tildePath(file: string, home = os.homedir()): string {
  return file.startsWith(home + path.sep) ? '~' + file.slice(home.length) : file
}

/** "Claude Code (~/.claude/settings.json)" for each file that changed (or, for a dry run, would). */
export function changedFiles(results: AgentRemoval[], home?: string): string[] {
  return results.filter(r => r.changed).map(r => `${r.agent} (${tildePath(r.file, home)})`)
}

function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** What a finished removal says: which files changed, what was left alone and why, what failed,
 *  and that TraceRoost won't set the agents up again on its own. One paragraph, for a toast, a
 *  terminal or the Settings panel. */
export function describeRemoval(results: AgentRemoval[], home?: string): string {
  const changed = changedFiles(results, home)
  const parts: string[] = []
  if (changed.length > 0) {
    const copilot = results.some(r => r.changed && r.agent === 'Copilot')
    parts.push(`Removed TraceRoost's settings from ${list(changed)}. Restart those agents${copilot ? ' (reload the editor for Copilot)' : ''} so they stop sending to TraceRoost.`)
  } else {
    parts.push('No TraceRoost agent settings were found to remove.')
  }
  const leftAlone = results.filter(r => r.warning).length
  if (leftAlone > 0) parts.push(`Left ${leftAlone === 1 ? 'one file' : `${leftAlone} files`} alone that ${leftAlone === 1 ? 'sends' : 'send'} to another collector.`)
  const failed = results.filter(r => r.error)
  if (failed.length > 0) parts.push(`Could not change ${list(failed.map(r => `${r.agent} (${tildePath(r.file, home)})`))}.`)
  parts.push("TraceRoost won't set up your agents again unless you choose Set up agents.")
  return parts.join(' ')
}
