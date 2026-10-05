/**
 * Display names and log locations for each `LogReader` agent key, for the startup
 * "Loaded N traces from local logs" line. One table for the standalone server; src/extension.ts
 * carries its own copy of the label half (the two had already drifted — this one lacked `cursor`),
 * so a new agent key is added here and there together until the extension imports this table.
 */

export const AGENT_KEY_LABEL: Record<string, string> = {
  claude:               'Claude Code',
  codex:                'Codex',
  copilot:              'Copilot CLI',
  copilot_vscode:       'Copilot (VS Code)',
  copilot_vscode_json:  'Copilot (VS Code)',
  opencode:             'OpenCode',
  cursor:               'Cursor CLI',
}

export const AGENT_KEY_DIR: Record<string, string> = {
  claude:               '~/.claude/projects/',
  codex:                '~/.codex/sessions/',
  copilot:              '~/.copilot/session-state/',
  copilot_vscode:       '~/Library/…/workspaceStorage/',
  copilot_vscode_json:  '~/Library/…/workspaceStorage/',
  opencode:             '~/.local/share/opencode/',
  cursor:               '~/.cursor/projects/',
}

export function agentKeyLabel(key: string): string { return AGENT_KEY_LABEL[key] ?? key }
export function agentKeyDir(key: string): string { return AGENT_KEY_DIR[key] ?? key }
