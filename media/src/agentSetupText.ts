// Hand-copied mirror of ../../src/agentSetupText.ts (the source of truth) — the webview bundle
// can't import across media/tsconfig.json's rootDir (see signalFormulas.ts). Kept byte-identical
// below this header by src/test/agentSetupConsent.test.ts.

/** The question, in the words every host shows. */
export const AGENT_SETUP_QUESTION = 'Set up your coding agents to send their activity to TraceRoost?'

/** What saying yes does, plainly — shown with the question. */
export const AGENT_SETUP_EXPLANATION =
  'TraceRoost will edit the settings of Claude Code (~/.claude/settings.json), Codex ' +
  "(~/.codex/config.toml) and GitHub Copilot (your editor's settings) so they report each run — " +
  'including your prompts and tool output — to TraceRoost on this computer. Nothing is sent ' +
  'anywhere else, and a setting that already sends to a different collector is left alone. ' +
  'After a yes, later starts only keep the port in these settings current; a setting you remove ' +
  'stays removed. The first time it changes an existing Claude Code or Codex file, it saves the original beside ' +
  'it as <file>.traceroost.bak. Not now asks again next time; Don\'t set up stops asking. Either ' +
  "way you can set them up, or remove the setup, from the dashboard's Settings panel."

/** The three answers, as every host labels them. "Not now" records nothing, so the question
 *  comes back the next time TraceRoost starts; only "Don't set up" records the no. */
export const AGENT_SETUP_YES = 'Set up agents'
export const AGENT_SETUP_NOT_NOW = 'Not now'
export const AGENT_SETUP_DONT = "Don't set up"

/** Said once the user chose Don't set up, so they know what skipping costs and the way back. */
export const AGENT_SETUP_DECLINED =
  "TraceRoost won't set up your agents, so they won't send it live traces: it only sees what " +
  'their log files record — less detail for Claude Code, and little more than totals for Codex ' +
  "and Copilot CLI. You can set them up any time from the dashboard's Settings panel."
