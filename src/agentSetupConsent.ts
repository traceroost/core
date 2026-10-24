/**
 * Whether TraceRoost may set up the user's coding agents (src/autoConfigNode.ts) — asked once,
 * before any agent's configuration is touched, and remembered in `~/.traceroost/config.json`
 * (`agentSetup`), which the VS Code extension, the background service and `npx traceroost` all
 * share: answering in one of them answers it for the others.
 *
 * Setting an agent up edits a file that belongs to another product (`~/.claude/settings.json`,
 * `~/.codex/config.toml`, an editor's user settings) and turns on its prompt and tool-output
 * telemetry, so it waits for a yes. Where it asks:
 *   - VS Code: a notification on activation (src/extension.ts);
 *   - a terminal running `traceroost` or `traceroost service install`: one question, where `y` is
 *     a yes, Enter is "not now" and typing `never` is "don't set up";
 *   - the background service, which has no terminal: a dashboard banner (AgentSetupBanner).
 * Each offers the same three answers (AGENT_SETUP_YES / _NOT_NOW / _DONT). Only "Don't set up"
 * records the no; "Not now" — or dismissing the question — records nothing, so it is asked again
 * the next time TraceRoost starts. The stored values are still just 'yes' and 'no'.
 * The "Set up agents" button in the dashboard's Settings panel, VS Code's "TraceRoost: Set Up
 * Agents…" command and `traceroost agents setup` are themselves a yes; Remove agent setup
 * (src/agentSetupRemoval.ts) records a no.
 */

import { readServiceConfig, writeServiceConfig } from './serviceConfig'
import { AGENT_SETUP_QUESTION } from './agentSetupText'

export { AGENT_SETUP_DECLINED, AGENT_SETUP_DONT, AGENT_SETUP_EXPLANATION, AGENT_SETUP_NOT_NOW, AGENT_SETUP_QUESTION, AGENT_SETUP_YES } from './agentSetupText'

export type AgentSetupAnswer = 'yes' | 'no'

/** The stored answer, or undefined when the user hasn't answered yet. */
export function readAgentSetupAnswer(baseHome?: string): AgentSetupAnswer | undefined {
  const answer: unknown = readServiceConfig(baseHome).agentSetup
  return answer === 'yes' || answer === 'no' ? answer : undefined
}

export function writeAgentSetupAnswer(answer: AgentSetupAnswer, baseHome?: string): void {
  const config = readServiceConfig(baseHome)
  writeServiceConfig({ ...config, agentSetup: answer }, baseHome)
}

/** The terminal question's prompt line — its three answers spelled out. */
export const AGENT_SETUP_TERMINAL_PROMPT = 'Set up agents? [y = yes, Enter = not now, "never" = don\'t set up] '

/** The terminal answer: `y`/`yes` (any case) is a yes, `never` is "don't set up" (a no), and
 *  anything else — Enter above all — is "not now" (undefined: nothing is recorded). */
export function parseAgentSetupInput(input: string): AgentSetupAnswer | undefined {
  if (/^\s*y(es)?\s*$/i.test(input)) return 'yes'
  if (/^\s*never\s*$/i.test(input)) return 'no'
  return undefined
}

/** What the Set Up Agents command reports when it changed nothing: `undefined` when no agent was
 *  left alone (the caller says everything is already set up), otherwise one sentence naming the
 *  agents whose settings already export OTel somewhere else — so their traces don't reach this
 *  port — rather than claiming nothing needed changing. The log has each file and endpoint. */
export function leftAloneMessage(agents: string[], port: number): string | undefined {
  if (agents.length === 0) return undefined
  const names = agents.length === 1 ? agents[0] : `${agents.slice(0, -1).join(', ')} and ${agents[agents.length - 1]}`
  const [they, their] = agents.length === 1 ? ['it', 'its'] : ['they', 'their']
  return `TraceRoost: left ${names} alone — ${they} already send${agents.length === 1 ? 's' : ''} OTel to another collector, so ${their} traces won't reach port ${port}. Show Log has the details.`
}

/** The one line printed when startup output has pushed the terminal question out of sight. */
export function agentSetupWaitingLine(): string {
  return `[TraceRoost] Still waiting for your answer: ${AGENT_SETUP_QUESTION} ` +
    '(y = yes, Enter = not now, "never" = don\'t set up; details above, or answer in the dashboard)'
}
