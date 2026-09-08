/** Same convention as the Dockerfile's HEALTHCHECK (`wget -qO- http://localhost:3000/health`) —
 *  any 200 from the UI port's unauthenticated /health route means the server is up. Used for
 *  `traceroost service status` across all three platforms instead of parsing
 *  launchctl/systemctl/schtasks output, which is more meaningful ("is TraceRoost actually
 *  reachable") and avoids three different fragile text-parsing paths. /health (rather than /)
 *  is required now that / requires the auth token — see src/httpSecurity.ts. */
export async function probeServiceHealth(uiPort: number, bindHost: string): Promise<boolean> {
  const host = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost
  try {
    const res = await fetch(`http://${host}:${uiPort}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/** Polls `probeServiceHealth` until it succeeds or `timeoutMs` elapses. Used right after
 *  `service install` to confirm the freshly-registered service actually came up, rather than
 *  printing "installed and started" and hoping. */
export async function waitForServiceHealth(uiPort: number, bindHost: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probeServiceHealth(uiPort, bindHost)) { return true }
    if (Date.now() >= deadline) { return false }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}
