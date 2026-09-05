/**
 * `agentlens team <link|status|leave>` — the CLI half of AL 01.
 *
 * Pure orchestration over `src/team/`. Prints the exact same SENT / NEVER_SENT list the Team
 * panel and the OAuth consent screen show, then runs the PKCE flow (or the `--device` fallback).
 */

import { linkInteractive, linkViaDevice, leave } from '../src/team/link'
import { getTeamStatus } from '../src/team/status'
import { SENT, NEVER_SENT, whoSeesWhat, LEAVE_HINT } from '../src/team/privacy'
import { loadCredentials } from '../src/team/credentials'
import { teamEndpoint } from '../src/team/config'

function printPromise(): void {
  console.log('\nWhat a linked machine sends:')
  for (const s of SENT) console.log(`  • ${s}`)
  console.log('\nWhat it never sends:')
  for (const s of NEVER_SENT) console.log(`  • ${s}`)
  console.log('')
}

async function runLink(args: string[]): Promise<number> {
  if (loadCredentials()) {
    console.log('This machine is already linked. Run `agentlens team leave` first to re-link.')
    return 1
  }
  const device = args.includes('--device')
  console.log(`Linking this machine to AgentLens Pro at ${teamEndpoint()}.`)
  printPromise()
  console.log(LEAVE_HINT + '\n')

  try {
    if (device) {
      const result = await linkViaDevice({
        onPrompt: ({ userCode, verificationUri, verificationUriComplete }) => {
          console.log('To approve this machine, open:')
          console.log(`  ${verificationUriComplete ?? verificationUri}`)
          console.log(`and enter the code:  ${userCode}\n`)
          console.log('Waiting for approval…')
        },
      })
      console.log(`\n✓ Linked to ${result.orgName} as ${result.role}.`)
      return 0
    }

    const result = await linkInteractive({
      onUrl: (url) => {
        console.log('Opening your browser to approve this machine. If it does not open, visit:')
        console.log(`  ${url}\n`)
      },
    })
    console.log(`\n✓ Linked to ${result.orgName} as ${result.role}.`)
    const after = getTeamStatus()
    console.log(whoSeesWhat(after.perDeveloperVisibility ?? false, result.orgName))
    return 0
  } catch (err) {
    console.error(`\n✗ Link failed: ${(err as Error).message}`)
    console.error('Nothing was changed. This machine is still working exactly as before, sending nothing.')
    return 1
  }
}

function runStatus(): number {
  const status = getTeamStatus()
  if (!status.linked) {
    console.log('Not linked. AgentLens is working locally and sending nothing anywhere.')
    console.log('Run `agentlens team link` to join a team.')
    return 0
  }
  console.log(`Linked to ${status.orgName} (${status.orgId})`)
  console.log(`  Member:        ${status.memberId} (${status.role})`)
  console.log(`  Endpoint:      ${status.endpoint}`)
  console.log(`  Linked at:     ${status.linkedAt}`)
  console.log(`  Client:        v${status.clientVersion}`)
  console.log(`  Queue depth:   ${status.queueDepth ?? 0}`)
  console.log(`  Last rollup:   ${status.lastRollupAt ?? 'none yet'}`)
  console.log(`  Per-developer visibility: ${status.perDeveloperVisibility ? 'on' : 'off'}`)
  if (status.degradedReason) console.log(`  ⚠ ${status.degradedReason}`)
  return 0
}

async function runLeave(): Promise<number> {
  const result = await leave()
  if (!result.wasLinked) {
    console.log('This machine was not linked. Nothing to do.')
    return 0
  }
  console.log('✓ Unlinked. The local credential is deleted and this machine has stopped forwarding.')
  if (!result.serverRevoked) {
    console.log('  (Could not reach the server to revoke the token — it will be revoked on its next contact, or a lead can revoke it from the roster.)')
  }
  return 0
}

export async function runTeamCli(args: string[]): Promise<number> {
  const sub = args[0]
  switch (sub) {
    case 'link':   return runLink(args.slice(1))
    case 'status': return runStatus()
    case 'leave':  return runLeave()
    default:
      console.log('Usage: agentlens team <link|status|leave> [--device]')
      console.log('  link    Join a team (opens a browser; --device for headless machines)')
      console.log('  status  Show this machine\'s Pro state')
      console.log('  leave   Unlink this machine (local-first, works offline)')
      return sub ? 1 : 0
  }
}
