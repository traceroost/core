// The final AgentLens release's "we've moved" notice. AgentLens is now TraceRoost: this
// package (`agentlens-dashboard`) and the `agentlens/agentlens` image get no further updates.
// Printed at server startup (npx, global install, service logs, Docker logs) and before every
// `service` subcommand, so it's seen however AgentLens is run.

const LINES = [
  'AgentLens is now TraceRoost. This is the final AgentLens release — it gets no more updates.',
  '',
  'Switch:  npx traceroost@latest',
  'Docker:  docker run --pull=always -p 127.0.0.1:3000:3000 -p 127.0.0.1:4318:4318 traceroost/traceroost',
  '',
  'Running AgentLens as a background service? Remove it first so the two don\'t fight over ports:',
  '         npx agentlens-dashboard@latest service uninstall',
  '         npx traceroost@latest service install',
  '',
  'TraceRoost rebuilds your history from your agents\' local session files on first run.',
  'More: https://github.com/traceroost/core',
]

export function printMovedNotice(log: (line: string) => void = console.log): void {
  const width = Math.max(...LINES.map(l => l.length))
  const bar = '─'.repeat(width + 2)
  log(`┌${bar}┐`)
  for (const line of LINES) log(`│ ${line.padEnd(width)} │`)
  log(`└${bar}┘`)
}
