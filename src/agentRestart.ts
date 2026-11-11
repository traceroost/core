/**
 * Which coding agents still need a restart after agent setup rewrote their settings.
 *
 * An agent reads its OTLP endpoint once, when it starts. So after setup changes a settings file
 * (the first yes, or the OTLP port moving after a port fallback), sessions that were already
 * running keep their old settings: no telemetry, or telemetry to the port TraceRoost left. Both
 * hosts keep one tracker and show its state as a dashboard banner (AgentRestartBanner in
 * media/src/App.tsx) until each agent is seen on the collector or the user dismisses it.
 *
 * In memory only. A later start reports `changed` again only if it really rewrote a file, so a
 * host restart drops whatever was still listed.
 */

import type { AdapterKey } from './adapters/types'

export type RestartAgent = 'claudeCode' | 'codex' | 'copilot'

/** What the dashboard shows: the port the agents were pointed at and who still has to restart.
 *  Mirrored as AgentRestartNeeded in media/src/types.ts. */
export interface AgentRestartNeeded {
  port: number
  agents: RestartAgent[]
}

const ORDER: RestartAgent[] = ['claudeCode', 'codex', 'copilot']

/** The agent setup configures for each OTLP adapter. Copilot setup writes VS Code settings only,
 *  so the Copilot CLI's telemetry says nothing about whether the editor was reloaded. */
function restartAgentOf(adapter: AdapterKey): RestartAgent | undefined {
  if (adapter === 'claude') return 'claudeCode'
  if (adapter === 'codex') return 'codex'
  if (adapter === 'copilot_vscode') return 'copilot'
  return undefined
}

export class AgentRestartTracker {
  private pending = new Set<RestartAgent>()
  private port = 0

  constructor(private readonly onChange: (state: AgentRestartNeeded | null) => void = () => {}) {}

  /** A setup run finished: every agent whose settings it changed now needs a restart. */
  noteSetup(port: number, results: Partial<Record<RestartAgent, { changed?: boolean } | undefined>>): void {
    const changed = ORDER.filter(a => results[a]?.changed === true)
    if (changed.length === 0) return
    // A different port makes the earlier list out of date: those agents were pointed at a port
    // this run did not confirm, and a file it left unchanged this time was already current.
    if (port !== this.port) this.pending.clear()
    this.port = port
    for (const a of changed) this.pending.add(a)
    this.onChange(this.state())
  }

  /** The collector received a record from this agent, so at least one session of it started
   *  after setup. Called per record: returns fast when nothing is pending. */
  noteOtlp(adapter: AdapterKey): void {
    if (this.pending.size === 0) return
    const agent = restartAgentOf(adapter)
    if (!agent || !this.pending.delete(agent)) return
    this.onChange(this.state())
  }

  /** The user dismissed the banner, or agent setup was removed. */
  dismiss(): void {
    if (this.pending.size === 0) return
    this.pending.clear()
    this.onChange(null)
  }

  state(): AgentRestartNeeded | null {
    if (this.pending.size === 0) return null
    return { port: this.port, agents: ORDER.filter(a => this.pending.has(a)) }
  }
}
