import type { ConfigResult } from '../src/autoConfigNode'

export interface AutoConfigLogLine { level: 'log' | 'warn'; text: string }

/** What the standalone server prints after auto-configuring the three agents at startup. Every
 *  agent's `warning` is surfaced — Claude Code, Codex and each Copilot settings file can all
 *  decline to overwrite a user-set, non-local OTEL endpoint, and that's worth saying out loud
 *  (src/extension.ts logs the same warnings to its output channel). */
export function autoConfigLogLines(claude: ConfigResult, codex: ConfigResult, copilot: ConfigResult[]): AutoConfigLogLine[] {
  const lines: AutoConfigLogLine[] = []
  const warn = (text: string) => lines.push({ level: 'warn', text: `[TraceRoost] ${text}` })
  const log = (text: string) => lines.push({ level: 'log', text: `[TraceRoost] ${text}` })

  if (claude.warning) warn(claude.warning)
  if (claude.error) warn(`Could not auto-configure Claude Code: ${claude.error}`)
  else if (claude.changed) log('Claude Code configured — restart Claude Code in your terminal to activate tracing')

  if (codex.warning) warn(codex.warning)
  if (codex.error) warn(`Could not auto-configure Codex: ${codex.error}`)
  else if (codex.changed) log('Codex configured — restart Codex in your terminal to activate tracing')

  for (const r of copilot) if (r.warning) warn(r.warning)
  if (copilot.some(r => r.changed)) {
    log('Copilot configured — reload VS Code window to activate tracing (Ctrl+Shift+P → "Reload Window")')
  }
  for (const r of copilot) if (r.error) warn(`Could not auto-configure Copilot: ${r.error}`)
  return lines
}
