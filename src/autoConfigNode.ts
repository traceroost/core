import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import { modify, applyEdits, parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { VSCODE_FAMILY_IDE_NAMES } from './vscodeFamilyIdes'

export interface ConfigResult {
  changed: boolean
  error?: string
  /** Non-fatal note — e.g. a user-set value was deliberately left alone. */
  warning?: string
}

/**
 * Reads a config file, distinguishing "doesn't exist" (→ `undefined`, safe to create) from every
 * other read failure (permissions, EISDIR, …), which is thrown so the caller skips the file instead
 * of clobbering something it couldn't see.
 */
async function readIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') { return undefined }
    throw e
  }
}

/**
 * Writes `content` to `filePath` atomically (temp file + rename in the same directory). When the
 * file already existed, a one-time `<file>.traceroost.bak` copy of the original is kept first —
 * never overwritten afterwards, so it always holds the user's pre-TraceRoost version.
 */
async function writeConfigFile(filePath: string, content: string, existed: boolean): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  let mode: number | undefined
  if (existed) {
    try {
      await fs.copyFile(filePath, `${filePath}.traceroost.bak`, fs.constants.COPYFILE_EXCL)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { throw e }
    }
    try { mode = (await fs.stat(filePath)).mode & 0o777 } catch { /* keep default */ }
  }
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode })
    await fs.rename(tmp, filePath)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

/** True for an OTLP endpoint on this machine — the only kind TraceRoost ever writes, so the only
 *  kind it may take back over (its port can legitimately move after a port fallback). */
function isLoopbackEndpoint(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
  } catch {
    return false
  }
}

export async function autoConfigureCodex(port: number): Promise<ConfigResult> {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const endpoint = `http://localhost:${port}`

  // Required keys in the [otel] section, in preferred insertion order.
  const requiredOtelKeys: Array<{ key: string; line: string }> = [
    { key: 'log_user_prompt',  line: 'log_user_prompt = true' },
    { key: 'exporter',         line: `exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json" } }` },
    { key: 'trace_exporter',   line: `trace_exporter = { otlp-http = { endpoint = "${endpoint}", protocol = "json" } }` },
  ]
  // One assignment line of `key`: `key = …`, a dotted `key.sub = …`, or the quoted-key forms.
  const keyLineRe = (key: string) => new RegExp(`^\\s*(${key}|"${key}"|'${key}')\\s*[=.]`)

  try {
    const content = await readIfExists(configPath)
    if (content === undefined) {
      const block = requiredOtelKeys.map(k => k.line).join('\n')
      await writeConfigFile(configPath, `[otel]\n${block}\n`, false)
      return { changed: true }
    }

    const lines = content.split('\n')

    // A key the user already wrote as its own sub-table (`[otel.exporter]`,
    // `[otel.exporter.otlp-http]`) can't also get an inline `exporter = …` — TOML rejects the
    // duplicate and Codex would refuse to start. Leave hand-written layouts like that alone.
    const subTabled = requiredOtelKeys.find(({ key }) =>
      lines.some(l => new RegExp(`^\\s*\\[\\s*otel\\s*\\.\\s*${key}\\s*[.\\]]`).test(l))
    )
    if (subTabled) {
      return {
        changed: false,
        error: `${configPath} defines [otel.${subTabled.key}] as a table — left untouched; point it at ${endpoint} manually`,
      }
    }

    // `[otel]` may carry a trailing comment or inner spaces — an exact-string match missed those
    // and appended a second [otel] table, which TOML rejects.
    const otelIdx = lines.findIndex(l => /^\[\s*otel\s*\]\s*(#.*)?$/.test(l.trim()))

    if (otelIdx === -1) {
      const block = requiredOtelKeys.map(k => k.line).join('\n')
      const newContent = content.trimEnd() + `\n\n[otel]\n${block}\n`
      await writeConfigFile(configPath, newContent, true)
      return { changed: true }
    }

    let sectionEnd = lines.length
    for (let i = otelIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('[')) { sectionEnd = i; break }
    }

    // Insert or update each required key within the [otel] section. A key may be spread over
    // several dotted lines (`exporter.otlp-http.endpoint = …`): the first becomes our line and the
    // rest are dropped, otherwise the result would define the key twice.
    // Iterate in reverse insertion order so splice indices stay valid.
    let changed = false
    for (const { key, line } of [...requiredOtelKeys].reverse()) {
      const re = keyLineRe(key)
      const matches: number[] = []
      for (let i = otelIdx + 1; i < sectionEnd; i++) {
        if (re.test(lines[i])) { matches.push(i) }
      }
      // An exporter line already aimed at this endpoint is left alone — it may carry extras we
      // don't write ourselves, e.g. the `headers = { "Authorization" = … }` a LAN/Docker setup needs.
      const alreadyOurs = matches.length === 1 && key !== 'log_user_prompt'
        && lines[matches[0]].includes(`endpoint = "${endpoint}"`)
      if (alreadyOurs) {
        continue
      } else if (matches.length > 0) {
        if (lines[matches[0]] !== line) { lines[matches[0]] = line; changed = true }
        for (const idx of matches.slice(1).reverse()) {
          lines.splice(idx, 1)
          sectionEnd--
          changed = true
        }
      } else {
        lines.splice(otelIdx + 1, 0, line)
        sectionEnd++
        changed = true
      }
    }

    if (!changed) {
      return { changed: false }
    }
    await writeConfigFile(configPath, lines.join('\n'), true)
    return { changed: true }
  } catch (e) {
    return { changed: false, error: String(e) }
  }
}

// Earlier versions installed a Claude Code Stop hook that printed ~/.traceroost/pending-prompt.txt
// into the session. Nothing writes that file any more, and any local process could, so the hook
// is no longer installed and existing copies are removed below.
const LEGACY_STOP_HOOK_MARKER = '.traceroost/pending-prompt.txt'

/** Strips TraceRoost's legacy Stop hook from Claude settings, leaving every other hook as is.
 *  Returns true when something was removed. */
export function removeLegacyStopHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false
  const byEvent = hooks as Record<string, unknown>
  const stop = byEvent.Stop
  if (!Array.isArray(stop)) return false

  let removed = false
  const kept: unknown[] = []
  for (const entry of stop) {
    const inner = (entry as { hooks?: unknown } | null)?.hooks
    if (!Array.isArray(inner)) { kept.push(entry); continue }
    const remaining = inner.filter(h => {
      const command = (h as { command?: unknown } | null)?.command
      const isLegacy = typeof command === 'string' && command.includes(LEGACY_STOP_HOOK_MARKER)
      if (isLegacy) removed = true
      return !isLegacy
    })
    if (remaining.length > 0) kept.push({ ...(entry as object), hooks: remaining })
    else if (remaining.length === inner.length) kept.push(entry)
  }
  if (!removed) return false

  if (kept.length > 0) byEvent.Stop = kept
  else delete byEvent.Stop
  if (Object.keys(byEvent).length === 0) delete settings.hooks
  return true
}

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
    const raw = await readIfExists(settingsPath)
    let settings: Record<string, unknown> = {}
    if (raw !== undefined && raw.trim() !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        // Never rewrite a file we couldn't parse — the user's settings would be replaced wholesale.
        return { changed: false, error: `${settingsPath} is not valid JSON (${(e as Error).message}) — left untouched` }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { changed: false, error: `${settingsPath} is not a JSON object — left untouched` }
      }
      settings = parsed as Record<string, unknown>
    }
    if (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
      return { changed: false, error: `${settingsPath} has a non-object "env" — left untouched` }
    }

    const existingEnv = (settings.env as Record<string, string>) ?? {}
    let changed = false
    let warning: string | undefined
    for (const [key, value] of Object.entries(requiredEnv)) {
      const current = existingEnv[key]
      if (key === 'OTEL_EXPORTER_OTLP_ENDPOINT' && current && !isLoopbackEndpoint(current)) {
        // The user exports to a collector of their own — don't hijack it.
        warning = `OTEL_EXPORTER_OTLP_ENDPOINT in ${settingsPath} points at ${current}; left as is (TraceRoost listens on http://localhost:${port})`
        continue
      }
      if (current !== value) {
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

    if (removeLegacyStopHook(settings)) changed = true

    if (!changed) {
      return { changed: false, warning }
    }

    settings.env = existingEnv
    await writeConfigFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', raw !== undefined)

    return { changed: true, warning }
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
      const raw = await readIfExists(settingsPath)
      // VS Code settings are JSONC — comments and trailing commas are normal. Edit the text in
      // place (as VS Code itself does) so everything we don't touch survives byte for byte.
      let text = raw ?? ''
      let settings: Record<string, unknown> = {}
      if (text.trim() !== '') {
        const errors: ParseError[] = []
        const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false })
        if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const why = errors.length > 0 ? printParseErrorCode(errors[0].error) : 'not an object'
          results.push({ changed: false, error: `${settingsPath} could not be parsed (${why}) — left untouched` })
          continue
        }
        settings = parsed as Record<string, unknown>
      }

      let changed = false
      for (const [key, value] of Object.entries(required)) {
        if (settings[key] !== value) {
          text = applyEdits(text, modify(text, [key], value, {
            formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
          }))
          changed = true
        }
      }

      if (!changed) { results.push({ changed: false }); continue }

      if (!text.endsWith('\n')) { text += '\n' }
      await writeConfigFile(settingsPath, text, raw !== undefined)
      results.push({ changed: true })
    } catch (e) {
      results.push({ changed: false, error: String(e) })
    }
  }

  return results
}

