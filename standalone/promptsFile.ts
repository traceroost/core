/** Where an automation prompt for `agent` (a session source id) is appended when "Write prompts
 *  file" is on: one file per agent, `traceroost-prompts-<slug>.md`. The slug is the source id,
 *  except Claude Code keeps its long-standing `claude` (so an existing file isn't orphaned); an
 *  unrecognized id falls back to `copilot`, as before. Keep in step with src/dashboardPanel.ts's
 *  writeAutomationPrompt. */
const AGENTS: Record<string, { slug: string; name: string }> = {
  claude_code: { slug: 'claude',   name: 'Claude' },
  codex:       { slug: 'codex',    name: 'Codex' },
  copilot:     { slug: 'copilot',  name: 'Copilot' },
  opencode:    { slug: 'opencode', name: 'OpenCode' },
  cursor:      { slug: 'cursor',   name: 'Cursor' },
}

export function promptsFileFor(agent: unknown): { filename: string; agentName: string } {
  const a = (typeof agent === 'string' && Object.hasOwn(AGENTS, agent) ? AGENTS[agent] : undefined) ?? AGENTS.copilot
  return { filename: `traceroost-prompts-${a.slug}.md`, agentName: a.name }
}

/** Session sources `/api/import` accepts — the same set media/src/tabs/Import.tsx validates. */
export const IMPORT_SOURCES: ReadonlySet<string> = new Set(Object.keys(AGENTS))
