/**
 * `traceroost team <link|status|leave>` — the CLI half of AL 01.
 *
 * Pure orchestration over `src/team/`. Prints the exact same SENT / NEVER_SENT list the Team
 * panel and the OAuth consent screen show, then runs the PKCE flow (or the `--device` fallback).
 */

import { linkInteractive, linkViaDevice, leave } from '../../src/cloud/team/link'
import { getTeamStatus } from '../../src/cloud/team/status'
import { getQueueStats } from '../../src/cloud/forward/currentQueueStats'
import { SENT, NEVER_SENT, whoSeesWhat, LEAVE_HINT } from '../../src/cloud/team/privacy'
import { loadCredentials } from '../../src/cloud/team/credentials'
import { teamEndpoint } from '../../src/cloud/team/config'
import { fetchInstallStats } from '../../src/cloud/team/oauthClient'
import { readServiceConfig } from '../../src/serviceConfig'

function printPromise(): void {
  console.log('\nWhat a linked machine sends:')
  for (const s of SENT) console.log(`  • ${s}`)
  console.log('\nWhat it never sends:')
  for (const s of NEVER_SENT) console.log(`  • ${s}`)
  console.log('')
}

async function runLink(args: string[]): Promise<number> {
  if (loadCredentials()) {
    console.log('This machine is already linked. Run `traceroost team leave` first to re-link.')
    return 1
  }
  const device = args.includes('--device')
  console.log(`Linking this machine to TraceRoost Cloud at ${teamEndpoint()}.`)
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
  const status = getTeamStatus(getQueueStats())
  if (!status.linked) {
    console.log('Not linked. TraceRoost is working locally and sending nothing anywhere.')
    console.log('Run `traceroost team link` to join a team.')
    return 0
  }
  console.log(`Linked to ${status.orgName} (${status.orgId})`)
  console.log(`  Member:        ${status.email ?? status.memberId} (${status.role})`)
  console.log(`  Endpoint:      ${status.endpoint}`)
  console.log(`  Linked at:     ${status.linkedAt}`)
  console.log(`  Client:        v${status.clientVersion}`)
  console.log(`  Queue depth:   ${status.queueDepth ?? 0}`)
  console.log(`  Last trace:    ${status.lastRollupAt ?? 'none yet'}`)
  console.log(`  Per-developer visibility: ${status.perDeveloperVisibility ? 'on' : 'off'}`)
  if (status.degradedReason) console.log(`  ⚠ ${status.degradedReason}`)
  return 0
}

/**
 * `traceroost team verify` — the one network call `status` deliberately never makes (see the
 * doc comment on getTeamStatus: local-only, by design), for the question status can't answer:
 * does the server actually have everything this machine sees locally.
 *
 * Reads the local count from the running standalone server's own /api/summary — the same total
 * the dashboard shows — via the port + auth token `readServiceConfig()` already persists, so
 * this needs no new local plumbing. If the server isn't running, that fetch fails and this says
 * so plainly rather than guessing at a count.
 *
 * A live mismatch isn't automatically a bug: a session still being actively written to hasn't
 * reached the server yet and correctly shouldn't have — see checkStaleOtelSessions in
 * standalone/server.ts for why an OTEL-only session needs a few idle minutes before it's
 * eligible at all. This prints the raw numbers and lets that ambiguity stay visible rather than
 * papering over it with a false "all good."
 */
async function runVerify(): Promise<number> {
  const creds = loadCredentials()
  if (!creds) {
    console.log('Not linked — nothing to verify. Run `traceroost team link` to join a team.')
    return 0
  }

  const service = readServiceConfig()
  let localCount: number | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(`http://127.0.0.1:${service.uiPort}/api/summary?token=${service.authToken}`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (res.ok) {
      const body = (await res.json()) as { sessions?: unknown[] }
      localCount = Array.isArray(body.sessions) ? body.sessions.length : null
    }
  } catch { /* server not running or unreachable — reported below */ }

  const cloudStats = await fetchInstallStats(creds.accessToken, creds.endpoint)

  if (localCount === null) {
    console.log("Could not reach the local dashboard (is `traceroost` / the standalone server running?).")
    console.log('Nothing to compare against — start it and run this again.')
    return 1
  }
  if (!cloudStats) {
    console.log('Could not reach the server to check the cloud-side count. Nothing to compare.')
    return 1
  }

  console.log(`Local traces (this machine, per the running dashboard): ${localCount}`)
  console.log(`Cloud traces (this machine, per ${creds.endpoint}):     ${cloudStats.sessions}`)
  console.log(`Last one cloud received: ${cloudStats.lastAt ?? 'none yet'}`)

  const gap = localCount - cloudStats.sessions
  if (gap <= 0) {
    console.log('\n✓ Cloud has everything this machine currently sees locally.')
    return 0
  }
  console.log(
    `\n${gap} trace${gap === 1 ? '' : 's'} local but not (yet) in cloud. If you were mid-session ` +
      'just now, that alone can explain a small gap — an in-progress trace has nothing to send ' +
      'until it ends, and a just-finished OTEL-only one needs a few idle minutes before it\'s ' +
      'eligible. If the gap stays the same size a few minutes from now, run `traceroost team ' +
      'status` and check the queue depth and last-trace time for what\'s actually stuck.',
  )
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
    case 'verify': return runVerify()
    case 'leave':  return runLeave()
    default:
      console.log('Usage: traceroost team <link|status|verify|leave> [--device]')
      console.log('  link    Join a team (opens a browser; --device for headless machines)')
      console.log('  status  Show this machine\'s Pro state')
      console.log('  verify  Compare local trace count against what the server has')
      console.log('  leave   Unlink this machine (local-first, works offline)')
      return sub ? 1 : 0
  }
}
