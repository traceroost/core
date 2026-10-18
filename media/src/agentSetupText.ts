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
  'Not now? You can do it later with Configure OTEL in Settings.'

/** Shown when the user says no, so they skip setup knowing what it costs. */
export const AGENT_SETUP_SKIP_QUESTION = 'Skip agent setup?'

export const AGENT_SETUP_SKIP_EXPLANATION =
  "Without it, your agents won't send live traces to TraceRoost, so it only sees what their log " +
  'files record: less detail for Claude Code, and little more than totals for Codex and Copilot ' +
  'CLI. You can set them up any time with Configure OTEL in Settings.'
