/**
 * The one way a linked machine rotates its OAuth tokens (AL 01 / AL 04).
 *
 * Every refresh rotates the refresh token: the server hands back a new pair and the old refresh
 * token stops working (cloud `refreshTokens`, which also compare-and-swaps on the old hash). More
 * than one TraceRoost host can hold the same `~/.traceroost/team.json` — the editor extension, the
 * standalone server, a CLI run — so two of them refreshing at once used to mean one of them
 * presented an already-rotated token, got `invalid_grant`, and treated that as "this credential is
 * dead": it cleared the credential and unlinked a machine that was perfectly fine. Here the whole
 * refresh-then-save runs under the credential file's lock, and re-reads the file after acquiring
 * it: if another host already rotated, its fresh pair is used instead of refreshing again.
 *
 * Also the home of the proactive check: `accessTokenExpiresAt` is stored at every link/refresh, so
 * a caller can refresh just before the token lapses instead of eating a 401 first — the pricing
 * sync and cluster resolve, which have no retry loop of their own, used to just fail silently once
 * a machine had been idle for the token's one-hour lifetime.
 */

import { credentialStore, loadCredentials, saveCredentials } from './credentials'
import { refreshTokens, TokenRefreshError } from './oauthClient'
import { withFileLockAsync } from '../forward/fileLock'
import type { OrgCredentials } from './config'

/** Refresh this long before the access token actually expires, so a request never races expiry. */
const REFRESH_SKEW_MS = 60_000
/** After an `invalid_grant`, how long to wait before re-reading the credential file and trying once
 *  more: another host or process (one not using this lock, or the cloud's own compare-and-swap
 *  race) may have rotated the pair a moment ago. */
export const INVALID_GRANT_RECHECK_MS = 1_500

export interface RefreshOptions {
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

/** How many times one refresh token may be presented without a definite answer (the response was
 *  lost: a timeout, a dropped connection, a gateway error). The cloud honours the just-replaced
 *  token once more in a grace window — the replay after a lost response — but a *second* replay
 *  revokes the whole install. So: the original presentation plus one replay, never more. */
export const MAX_UNANSWERED_PRESENTATIONS = 2

/**
 * Rotates `stale`'s tokens and saves the result, under the credential file's lock. Returns the
 * credential to use from now on — which is another host's already-rotated one, untouched, if the
 * file no longer holds `stale`'s refresh token by the time the lock is held.
 *
 * Throws `TokenRefreshError` like `refreshTokens` does. A permanent (`invalid_grant`) failure is
 * re-checked against the file: right away, and again after `INVALID_GRANT_RECHECK_MS` — if
 * another host or process rotated in the meantime (one not using this lock, an older build), that's
 * a lost race, not a dead credential, and its tokens are returned instead. The same refresh token
 * is never sent again after an `invalid_grant`, and never more than `MAX_UNANSWERED_PRESENTATIONS`
 * times without an answer (counted in the credential file, so every host sees it) — re-sending a
 * replayed token would revoke the install. If the credential was removed (the machine left the
 * org meanwhile), throws a non-permanent error — there's nothing left here to clear.
 */
export async function refreshCredentials(stale: OrgCredentials, now: () => number = Date.now, opts: RefreshOptions = {}): Promise<OrgCredentials> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const run = async (): Promise<OrgCredentials> => {
    const current = loadCredentials()
    if (!current) throw new TokenRefreshError('token refresh skipped: this machine is no longer linked', false)
    if (current.refreshToken !== stale.refreshToken) return current
    if ((current.unansweredRefreshes ?? 0) >= MAX_UNANSWERED_PRESENTATIONS) {
      throw new TokenRefreshError('token refresh failed: this refresh token was already presented twice without an answer', true)
    }
    let t
    try {
      t = await refreshTokens(current.refreshToken, current.endpoint)
    } catch (err) {
      const after = loadCredentials()
      if (after && after.refreshToken !== current.refreshToken) return after
      if (!(err instanceof TokenRefreshError) || err.unanswered) {
        // No definite answer — the server may have rotated it. Counted, so the replay happens once.
        if (after) saveCredentials({ ...after, unansweredRefreshes: (after.unansweredRefreshes ?? 0) + 1 })
        throw err
      }
      if (!err.permanent) throw err
      // invalid_grant: give a concurrent rotation a moment to land, then look again — but never
      // present this same token a second time.
      await sleep(INVALID_GRANT_RECHECK_MS)
      const later = loadCredentials()
      if (!later) throw new TokenRefreshError('token refresh skipped: this machine is no longer linked', false)
      if (later.refreshToken !== current.refreshToken) return later
      throw err
    }
    const next: OrgCredentials = {
      ...current,
      installId: current.installId ?? t.installId,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      accessTokenExpiresAt: now() + t.expiresInSeconds * 1000,
    }
    delete next.unansweredRefreshes
    saveCredentials(next)
    return next
  }
  const target = credentialStore().lockTarget
  return target ? withFileLockAsync(target, run) : run()
}

/** Whether `creds`' access token is expired or about to be. */
export function accessTokenExpiring(creds: OrgCredentials, now: () => number = Date.now): boolean {
  return creds.accessTokenExpiresAt - now() < REFRESH_SKEW_MS
}

/**
 * The current credential, refreshed first if its access token is expired or about to be. `null`
 * on an unlinked machine (AL 01: nothing else happens then). A failed proactive refresh is not an
 * error here — the stored credential is returned as-is and the request it's for will get a 401,
 * which each caller already handles (`fetchWithFreshToken` below, or sender.ts's own path, which
 * is the one place that acts on a permanently dead credential).
 */
export async function freshCredentials(now: () => number = Date.now): Promise<OrgCredentials | null> {
  const creds = loadCredentials()
  if (!creds) return null
  if (!accessTokenExpiring(creds, now)) return creds
  try {
    return await refreshCredentials(creds, now)
  } catch {
    return creds
  }
}

/**
 * Runs a bearer-authenticated request with a fresh access token, refreshing once and retrying on
 * a 401 — for the read-only calls (pricing sync, cluster resolve, roster/install lookups) that
 * have no retry loop of their own. Returns `null` on an unlinked machine. Network errors from
 * `doFetch` propagate; a refresh failure returns the original 401 response.
 */
export async function fetchWithFreshToken(doFetch: (creds: OrgCredentials) => Promise<Response>): Promise<Response | null> {
  let creds = await freshCredentials()
  if (!creds) return null
  const res = await doFetch(creds)
  if (res.status !== 401) return res
  try {
    creds = await refreshCredentials(creds)
  } catch {
    return res
  }
  return doFetch(creds)
}
