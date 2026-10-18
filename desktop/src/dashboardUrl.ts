/**
 * The dashboard URL the window loads, and the origin everything else is checked against.
 *
 * Two things make this more than string concatenation.
 *
 * The host: the collector binds loopback by default, and a loopback-bound collector needs no token
 * (`REQUIRE_TOKEN_EVERYWHERE = !isLoopbackHost(BIND_HOST)` in `standalone/server.ts`). A collector
 * someone configured with `BIND_HOST=0.0.0.0` does require one, and in attached mode that is a
 * collector this shell did not configure. The token lives in the local service config, so the
 * shell can read it — but it is passed once, in the first request, because the collector answers
 * it by setting a cookie and redirecting to the same page without it. Keeping the token out of the
 * window's committed URL keeps it out of the page's `location`, which trace content can read.
 *
 * The connection is still made to loopback whatever the collector bound: `0.0.0.0` means "every
 * interface", and the nearest one is the right one to talk to.
 */

export interface DashboardTarget {
  /** The URL to load first. May carry `?token=` on a non-loopback collector. */
  initialUrl: string
  /** The origin to validate every later navigation against. Never carries the token. */
  origin: string
}

/** Same loopback set `src/requestGuards.ts#isLoopbackHost` accepts. */
function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h.startsWith('127.')
}

export function dashboardTarget(opts: {
  uiPort: number
  /** The host the collector bound, from its service config. Defaults to loopback. */
  bindHost?: string
  /** The collector's auth token, if its config has one. Only used when it bound non-loopback. */
  authToken?: string
}): DashboardTarget {
  const origin = `http://127.0.0.1:${opts.uiPort}`
  const needsToken = opts.bindHost !== undefined && !isLoopback(opts.bindHost)
  if (needsToken && opts.authToken) {
    return { initialUrl: `${origin}/?token=${encodeURIComponent(opts.authToken)}`, origin }
  }
  return { initialUrl: `${origin}/`, origin }
}
