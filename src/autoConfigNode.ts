import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'

export interface ConfigResult {
  changed: boolean
  error?: string
}

export async function autoConfigureCodex(port: number): Promise<ConfigResult> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const endpoint = `http://localhost:${port}`

  // Required keys in the [otel] section, in preferred insertion order.
  const requiredOtelKeys: Array<{ prefix: string; line: string }> = [
    { prefix: 'log_user_prompt',  line: 'log_user_prompt = true' },
    { prefix: 'exporter',         line: `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json" } }` },
    { prefix: 'trace_exporter',   line: `trace_exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json" } }` },
  ]

  try {
    let content = ''
    try {
      content = await fs.readFile(configPath, 'utf-8')
    } catch {
      await fs.mkdir(codexHome, { recursive: true })
      const block = requiredOtelKeys.map(k => k.line).join('\n')
      await fs.writeFile(configPath, `[otel]\n${block}\n`, 'utf-8')
      return { changed: true }
    }

    if (requiredOtelKeys.every(k => content.includes(k.line))) {
      return { changed: false }
    }

    const lines = content.split('\n')
    const otelIdx = lines.findIndex(l => l.trim() === '[otel]')

    if (otelIdx === -1) {
      const block = requiredOtelKeys.map(k => k.line).join('\n')
      const newContent = content.trimEnd() + `\n\n[otel]\n${block}\n`
      await fs.writeFile(configPath, newContent, 'utf-8')
      return { changed: true }
    }

    let sectionEnd = lines.length
    for (let i = otelIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed.startsWith('[') && !trimmed.startsWith('#')) { sectionEnd = i; break }
    }

    // Insert or update each required key within the [otel] section.
    // Iterate in reverse insertion order so splice indices stay valid.
    for (const { prefix, line } of [...requiredOtelKeys].reverse()) {
      const existing = lines.findIndex(
        (l, i) => i > otelIdx && i < sectionEnd && l.trim().startsWith(prefix)
      )
      if (existing !== -1) {
        if (lines[existing] !== line) { lines[existing] = line }
      } else {
        lines.splice(otelIdx + 1, 0, line)
        sectionEnd++
      }
    }

    await fs.writeFile(configPath, lines.join('\n'), 'utf-8')
    return { changed: true }
  } catch (e) {
    return { changed: false, error: String(e) }
  }
}

const TRACEROOST_HOOK_MARKER = '.traceroost/pending-prompt.txt'
const TRACEROOST_HOOK_COMMAND =
  'f=$HOME/.traceroost/pending-prompt.txt; [ -f "$f" ] && cat "$f" && rm "$f"'

export async function autoConfigureClaudeCode(port: number): Promise<ConfigResult> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')

  const requiredEnv: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${port}`,
    OTEL_LOG_TOOL_DETAILS: '1',
    OTEL_LOG_TOOL_CONTENT: '1',
    OTEL_LOG_USER_PROMPTS: '1',
  }

  const staleKeys = [
    'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL',
    'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
    'OTEL_SEMCONV_STABILITY_OPT_IN',
    'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT',
  ]

  try {
    let settings: Record<string, unknown> = {}
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8')
      settings = JSON.parse(raw)
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh
    }

    const existingEnv = (settings.env as Record<string, string>) ?? {}
    let changed = false
    for (const [key, value] of Object.entries(requiredEnv)) {
      if (existingEnv[key] !== value) {
        existingEnv[key] = value
        changed = true
      }
    }
    for (const key of staleKeys) {
      if (key in existingEnv) {
        delete existingEnv[key]
        changed = true
      }
    }

    // Add Stop hook for standalone automation prompt injection (idempotent)
    type HookEntry = { matcher: string; hooks: Array<{ type: string; command: string }> }
    const hooks = (settings.hooks as Record<string, HookEntry[]> | undefined) ?? {}
    const stopHooks: HookEntry[] = hooks['Stop'] ?? []
    const hookAlreadyPresent = stopHooks.some(entry =>
      entry.hooks?.some(h => h.command?.includes(TRACEROOST_HOOK_MARKER))
    )
    if (!hookAlreadyPresent) {
      stopHooks.push({ matcher: '', hooks: [{ type: 'command', command: TRACEROOST_HOOK_COMMAND }] })
      hooks['Stop'] = stopHooks
      settings.hooks = hooks
      changed = true
    }

    if (!changed) {
      return { changed: false }
    }

    settings.env = existingEnv
    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')

    return { changed: true }
  } catch (e) {
    return { changed: false, error: String(e) }
  }
}

function vscodeUserSettingsPaths(): string[] {
  const home = os.homedir()
  let base: string
  if (process.platform === 'darwin') {
    base = path.join(home, 'Library', 'Application Support')
  } else if (process.platform === 'linux') {
    base = path.join(home, '.config')
  } else {
    base = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  }
  return VSCODE_FAMILY_IDE_NAMES.map(v => path.join(base, v, 'User', 'settings.json'))
}

export async function autoConfigureCopilotStandalone(port: number): Promise<ConfigResult[]> {
  const required: Record<string, unknown> = {
    'github.copilot.chat.otel.enabled':      true,
    'github.copilot.chat.otel.exporterType': 'otlp-http',
    'github.copilot.chat.otel.otlpEndpoint': `http://localhost:${port}`,
  }

  const results: ConfigResult[] = []

  for (const settingsPath of vscodeUserSettingsPaths()) {
    // Skip variants that aren't installed
    try { await fs.access(path.dirname(settingsPath)) } catch { continue }

    try {
      let settings: Record<string, unknown> = {}
      try {
        const raw = await fs.readFile(settingsPath, 'utf-8')
        settings = JSON.parse(raw)
      } catch { /* file missing or invalid — start fresh */ }

      let changed = false
      for (const [key, value] of Object.entries(required)) {
        if (settings[key] !== value) { settings[key] = value; changed = true }
      }

      if (!changed) { results.push({ changed: false }); continue }

      await fs.mkdir(path.dirname(settingsPath), { recursive: true })
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
      results.push({ changed: true })
    } catch (e) {
      results.push({ changed: false, error: String(e) })
    }
  }

  return results
}

