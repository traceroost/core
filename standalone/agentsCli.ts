/**
 * `traceroost agents <setup|remove>` — the agent-setup answer (src/agentSetupConsent.ts) given
 * from a terminal, without starting a server.
 *
 *  - `setup` is an explicit yes: it writes the full set of settings (SetupMode 'full') for the OTLP
 *    port a running TraceRoost server actually bound, else the configured one, and records the yes.
 *  - `remove` takes out exactly what setup wrote (src/agentSetupRemoval.ts) and records a no, so
 *    nothing sets the agents up again until the user asks.
 *
 * Neither runs when TRACEROOST_NO_AUTOCONFIG=1 ("never change any agent's settings"), nor in
 * Docker, where the files it could reach are the container's, not the host's.
 */

import { autoConfigureClaudeCode, autoConfigureCodex, autoConfigureCopilotStandalone } from '../src/autoConfigNode'
import { writeAgentSetupAnswer } from '../src/agentSetupConsent'
import { describeRemoval, removeAgentSetupFiles, tildePath } from '../src/agentSetupRemoval'
import { readResolvedPorts } from '../src/portResolver'
import { configuredPorts, readServiceConfig } from '../src/serviceConfig'
import { autoConfigLogLines } from './autoConfigLog'
import { AGENTS_USAGE } from './cliArgs'
import { isPidAlive } from './dataDirLock'


export interface AgentsCliIo {
  log: (line: string) => void
  error: (line: string) => void
  env: NodeJS.ProcessEnv
}

const defaultIo: AgentsCliIo = { log: l => console.log(l), error: l => console.error(l), env: process.env }

/** The OTLP port to point agents at: `--otlp-port`, else the port a running server recorded in
 *  ports.json (while that process is alive — it may have fallen back from the configured one),
 *  else the configured port. */
export function setupPort(flagPort: number | undefined, env: NodeJS.ProcessEnv, alive: (pid: number) => boolean = isPidAlive): number {
  if (flagPort !== undefined) return flagPort
  const resolved = readResolvedPorts()
  if (resolved && Number.isInteger(resolved.otlp) && alive(resolved.pid)) return resolved.otlp
  return configuredPorts(env, readServiceConfig()).otlp
}

/** `traceroost agents <sub> --help`. */
const SUBCOMMAND_HELP: Record<'setup' | 'remove', string> = {
  setup: 'Usage: traceroost agents setup [--otlp-port <port>]\n' +
    '  Set up Claude Code, Codex and Copilot to send their activity to TraceRoost (your yes).\n' +
    '  --otlp-port <port>  The port to point them at (default: the port a running TraceRoost\n' +
    '                      server receives on, else the configured one).',
  remove: 'Usage: traceroost agents remove\n' +
    '  Take out only the settings TraceRoost added, and stop setting agents up.',
}

export async function runAgentsCli(args: string[], io: AgentsCliIo = defaultIo): Promise<number> {
  const [sub, ...rest] = args
  if (sub !== 'setup' && sub !== 'remove') {
    (sub === undefined || sub === '--help' || sub === '-h' ? io.log : io.error)(`Usage: ${AGENTS_USAGE}\n` +
      '  setup   Set up Claude Code, Codex and Copilot to send their activity to TraceRoost (your yes).\n' +
      '  remove  Take out only the settings TraceRoost added, and stop setting agents up.')
    return sub === '--help' || sub === '-h' ? 0 : 1
  }
  if (rest.includes('--help') || rest.includes('-h')) { io.log(SUBCOMMAND_HELP[sub]); return 0 }
  let flagPort: number | undefined
  for (let i = 0; i < rest.length; i++) {
    if (sub === 'setup' && rest[i] === '--otlp-port') {
      const value = rest[i + 1]
      const n = Number(value)
      if (value === undefined || !/^\d+$/.test(value) || n < 1 || n > 65535) {
        io.error(`Invalid --otlp-port: ${value === undefined ? 'no port given' : `"${value}"`} — expected a port from 1 to 65535.`)
        return 1
      }
      flagPort = n; i++; continue
    }
    io.error(`Unknown option: ${rest[i]}\n${SUBCOMMAND_HELP[sub]}`)
    return 1
  }
  if (io.env.TRACEROOST_NO_AUTOCONFIG === '1') {
    io.error("[TraceRoost] TRACEROOST_NO_AUTOCONFIG=1 is set, so TraceRoost doesn't change any agent's settings.")
    return 1
  }
  if (io.env.TRACEROOST_DOCKER === '1') {
    io.error("[TraceRoost] Running in Docker: the agent settings here are the container's, not your computer's. Use the setup scripts on the host instead.")
    return 1
  }

  if (sub === 'remove') {
    const results = await removeAgentSetupFiles({ port: setupPort(undefined, io.env) })
    writeAgentSetupAnswer('no')
    for (const r of results) {
      if (r.changed) io.log(`[TraceRoost] ${r.agent}: removed TraceRoost's settings from ${tildePath(r.file)}`)
      if (r.warning) io.log(`[TraceRoost] ${r.agent}: ${r.warning}`)
      if (r.error) io.error(`[TraceRoost] ${r.agent}: ${r.error}`)
    }
    io.log(`[TraceRoost] ${describeRemoval(results)}`)
    return results.some(r => r.error) ? 1 : 0
  }

  const port = setupPort(flagPort, io.env)
  writeAgentSetupAnswer('yes')
  const [claude, codex, copilot] = await Promise.all([
    autoConfigureClaudeCode(port, 'full'),
    autoConfigureCodex(port, 'full'),
    autoConfigureCopilotStandalone(port, 'full'),
  ])
  for (const { level, text } of autoConfigLogLines(claude, codex, copilot)) (level === 'warn' ? io.error : io.log)(text)
  const changed = claude.changed || codex.changed || copilot.some(r => r.changed)
  const failed = !!claude.error || !!codex.error || copilot.some(r => r.error)
  if (!changed && !failed) io.log(`[TraceRoost] Your agents are already set up to send traces to http://localhost:${port}. Nothing needed changing.`)
  return failed ? 1 : 0
}
