import * as vscode from 'vscode'
import { isLoopbackEndpoint, type ConfigResult } from './autoConfigNode'
export type { ConfigResult } from './autoConfigNode'
export { autoConfigureClaudeCode, autoConfigureCodex } from './autoConfigNode'

export async function autoConfigureCopilot(port: number): Promise<ConfigResult> {
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

    const existing = config.get<string>('github.copilot.chat.otel.otlpEndpoint')
    if (typeof existing === 'string' && existing && !isLoopbackEndpoint(existing)) {
      // The user exports to a collector of their own — don't hijack it (same rule as Claude Code
      // and Codex in autoConfigNode.ts).
      return { changed, warning: `github.copilot.chat.otel.otlpEndpoint points at ${existing}; left as is (TraceRoost listens on ${endpoint})` }
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
