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
 *   - a terminal running `traceroost` or `traceroost service install`: a yes/no question;
 *   - the background service, which has no terminal: a dashboard banner (AgentSetupBanner).
 * Saying no asks once more, with what skipping costs (AGENT_SETUP_SKIP_*), before it is recorded.
 * The "Configure OTEL" button in the dashboard's Settings panel, and VS Code's "TraceRoost: Set Up
 * Agents…" command, are themselves a yes. Dismissing either question without
 * answering records nothing, so it is asked again next time.
 */

import { readServiceConfig, writeServiceConfig } from './serviceConfig'

export { AGENT_SETUP_EXPLANATION, AGENT_SETUP_QUESTION, AGENT_SETUP_SKIP_EXPLANATION, AGENT_SETUP_SKIP_QUESTION } from './agentSetupText'

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

/** `y`, `yes` (any case) is a yes; anything else, including an empty answer, is a no. */
export function parseYesNo(input: string): AgentSetupAnswer {
  return /^\s*y(es)?\s*$/i.test(input) ? 'yes' : 'no'
}

/** The answer to "Skip setup? [Y/n]": `n`/`no` takes it back (a yes to setup); anything else,
 *  Enter included, keeps the no. */
export function parseSkipConfirmation(input: string): AgentSetupAnswer {
  return /^\s*no?\s*$/i.test(input) && input.trim() !== '' ? 'yes' : 'no'
}
