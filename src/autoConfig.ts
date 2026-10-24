import * as vscode from 'vscode'
import { COPILOT_ENDPOINT_KEY, copilotSettings, isLoopbackEndpoint, isTraceRoostEndpoint, type ConfigResult, type SetupMode } from './autoConfigNode'
export type { ConfigResult, RemoveResult, SetupMode } from './autoConfigNode'
export { autoConfigureClaudeCode, autoConfigureCodex, removeClaudeCodeSetup, removeCodexSetup, removeCopilotStandaloneSetup } from './autoConfigNode'

export async function autoConfigureCopilot(port: number, mode: SetupMode = 'full'): Promise<ConfigResult> {
  try {
    const config = vscode.workspace.getConfiguration()
    const endpoint = `http://localhost:${port}`
    let changed = false

    // These settings only exist while GitHub Copilot Chat is installed. Without it, VS Code refuses
    // to write them ("… is not a registered configuration"), which used to surface on every
    // activation as an "Auto-configure Copilot failed" error plus a warning toast for anyone who
    // doesn't use Copilot. Nothing to configure then; the next activation after Copilot is
    // installed configures it.
    if (config.inspect('github.copilot.chat.otel.enabled')?.defaultValue === undefined) {
      return { changed: false }
    }

    // The user exports to a collector of their own: change nothing, before anything is touched —
    // turning `otel.enabled` on next to their endpoint would start sending Copilot telemetry there
    // because of TraceRoost (same rule as Claude Code and Codex in autoConfigNode.ts).
    const existing = config.get<string>('github.copilot.chat.otel.otlpEndpoint')
    if (typeof existing === 'string' && existing && !isLoopbackEndpoint(existing)) {
      return { changed: false, warning: `github.copilot.chat.otel.otlpEndpoint points at ${existing}; left untouched (TraceRoost listens on ${endpoint})` }
    }

    // 'maintain' (src/autoConfigNode.ts): only TraceRoost's own endpoint, when it is already there.
    if (mode === 'maintain') {
      if (!isTraceRoostEndpoint(existing) || existing === endpoint) return { changed: false }
      await config.update('github.copilot.chat.otel.otlpEndpoint', endpoint, vscode.ConfigurationTarget.Global)
      return { changed: true }
    }

    const otelEnabled = config.get<boolean>('github.copilot.chat.otel.enabled')
    if (!otelEnabled) {
      await config.update('github.copilot.chat.otel.enabled', true, vscode.ConfigurationTarget.Global)
      changed = true
    }

    const exporterType = config.get<string>('github.copilot.chat.otel.exporterType')
    if (exporterType !== 'otlp-http') {
      await config.update('github.copilot.chat.otel.exporterType', 'otlp-http', vscode.ConfigurationTarget.Global)
      changed = true
    }

    if (existing !== endpoint) {
      await config.update('github.copilot.chat.otel.otlpEndpoint', endpoint, vscode.ConfigurationTarget.Global)
      changed = true
    }

    return { changed }
  } catch (e) {
    return { changed: false, error: String(e) }
  }
}

/** Remove agent setup (src/autoConfigNode.ts) for this editor's Copilot settings, through the
 *  settings API like the setup above: drops the user-level values setup writes, while the
 *  endpoint is still TraceRoost's. */
export async function removeCopilotSetup(): Promise<ConfigResult> {
  try {
    const config = vscode.workspace.getConfiguration()
    if (config.inspect(COPILOT_ENDPOINT_KEY)?.defaultValue === undefined) return { changed: false }
    const endpoint = config.inspect<string>(COPILOT_ENDPOINT_KEY)?.globalValue
    if (typeof endpoint === 'string' && endpoint && !isTraceRoostEndpoint(endpoint)) {
      return { changed: false, warning: `${COPILOT_ENDPOINT_KEY} points at ${endpoint}, not TraceRoost; left untouched` }
    }
    if (!isTraceRoostEndpoint(endpoint)) return { changed: false }
    const ours = copilotSettings(0)
    for (const key of Object.keys(ours)) {
      if (key === COPILOT_ENDPOINT_KEY || config.inspect(key)?.globalValue === ours[key]) {
        await config.update(key, undefined, vscode.ConfigurationTarget.Global)
      }
    }
    return { changed: true }
  } catch (e) {
    return { changed: false, error: String(e) }
  }
}
