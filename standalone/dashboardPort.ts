/**
 * Settings → Dashboard port: moving the standalone dashboard to another port while it runs.
 *
 * The dashboard stays on 3000 by default. This is how a developer whose own dev server needs 3000
 * moves TraceRoost off it without touching anything else: agents send to the OTLP port and use the
 * MCP port, neither of which changes, so no agent config is rewritten.
 *
 * A move binds the new port *before* letting go of the old one and persists only once the bind
 * succeeded, so a refused port (in use, reserved) changes nothing. No restart: the same request
 * handler serves both listeners until the old one closes a few seconds later, after the page has
 * navigated to the new address. The page carries its per-origin preferences across in the URL
 * fragment (`carryImportScript`), since localStorage is keyed by origin and so by port.
 *
 * The background service reads the port back from config.json on its next start (configuredPorts
 * in src/serviceConfig.ts) — nothing about the service definition has to change.
 */
import type * as http from 'http'

export const DEFAULT_DASHBOARD_PORT = 3000

/** One line the CLI prints after the dashboard URL while the dashboard is on 3000 — the moment a
 *  developer is most likely to wonder how to get 3000 back for their own server. */
export const PORT_3000_HINT = 'Need port 3000 for a dev server? Move the dashboard in Settings → Dashboard port, or run `traceroost service install --ui-port <port>`.'
const MIN_PORT = 1024
const MAX_PORT = 65535

/** Why the port can't be changed from the dashboard, if it can't. `env`: UI_PORT is set in the
 *  environment and would win over a saved value. `network`: bound beyond loopback (LAN), where a
 *  port change usually needs a firewall change the page can't make. `docker`: the port is the
 *  container's `-p` mapping, not TraceRoost's to change. */
export type DashboardPortLock = 'env' | 'network' | 'docker' | null

export interface DashboardPortState {
  /** The port this dashboard is listening on right now. */
  port: number
  /** The port config.json asks for (differs from `port` after a startup fallback). */
  configured: number
  defaultPort: number
  lockedBy: DashboardPortLock
  /** dashboardPortLockReason(lockedBy), for the Settings row to show instead of the field. */
  lockedReason?: string
  /** Ports the dashboard may not take: the OTLP and MCP ports, and OTLP/gRPC. */
  reserved: number[]
}

export function dashboardPortLock(opts: { uiFromEnv: boolean; docker: boolean; requireToken: boolean }): DashboardPortLock {
  if (opts.docker) return 'docker'
  if (opts.uiFromEnv) return 'env'
  if (opts.requireToken) return 'network'
  return null
}

/** What the Settings row says instead of offering the change, for each lock. */
export function dashboardPortLockReason(lock: Exclude<DashboardPortLock, null>): string {
  switch (lock) {
    case 'env': return 'The UI_PORT environment variable sets the dashboard port, so it can\'t be changed here. Change or remove UI_PORT where it is set.'
    case 'network': return 'TraceRoost is reachable beyond this machine (BIND_HOST), where a port change usually needs a firewall change too. Use `traceroost service install --ui-port <port>`.'
    case 'docker': return 'In Docker the dashboard\'s port is the `-p <port>:3000` mapping on `docker run`. Change it there.'
  }
}

export type PortValidation =
  | { ok: true; port: number; rebind: boolean }
  | { ok: false; error: string }

/** Checks a requested port. `rebind: false` means the dashboard is already listening there and
 *  only config.json needs updating — choosing the port a startup fallback landed on makes it stick. */
export function validateDashboardPort(
  value: unknown,
  state: Pick<DashboardPortState, 'port' | 'configured' | 'reserved'>,
): PortValidation {
  const port = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return { ok: false, error: `Choose a whole number from ${MIN_PORT} to ${MAX_PORT}.` }
  }
  if (state.reserved.includes(port)) {
    return { ok: false, error: `Port ${port} is used by TraceRoost's agent connections (OTLP or MCP). Choose another.` }
  }
  if (port === state.port) {
    if (port === state.configured) return { ok: false, error: `The dashboard is already on port ${port}.` }
    return { ok: true, port, rebind: false }
  }
  return { ok: true, port, rebind: true }
}

/** One sentence for a bind failure, naming the port. */
export function describeBindError(port: number, err: NodeJS.ErrnoException): string {
  if (err.code === 'EADDRINUSE') return `Port ${port} is in use by another program. Choose another, or stop that program first.`
  if (err.code === 'EACCES') return `Port ${port} can't be used here (permission denied, or reserved by Windows). Choose another.`
  return `Couldn't listen on port ${port}: ${err.message}`
}

function listenOnce(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err) }
    const onListening = () => { server.removeListener('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export interface MoveDashboardOptions {
  port: number
  host: string
  /** The listener serving the dashboard now; closed `closeDelayMs` after a successful move. */
  current: http.Server
  /** A new listener with the same request handler. */
  createServer: () => http.Server
  /** Writes the new port to config.json. A throw undoes the bind and fails the move. */
  persist: (port: number) => void
  closeDelayMs?: number
}

export type MoveDashboardResult = { ok: true; server: http.Server } | { ok: false; error: string }

/** Binds `port`, persists it, then retires the old listener. On any failure nothing changes: the
 *  old listener keeps serving and config.json is untouched. */
export async function moveDashboard(opts: MoveDashboardOptions): Promise<MoveDashboardResult> {
  const next = opts.createServer()
  try {
    await listenOnce(next, opts.port, opts.host)
  } catch (err) {
    return { ok: false, error: describeBindError(opts.port, err as NodeJS.ErrnoException) }
  }
  try {
    opts.persist(opts.port)
  } catch (err) {
    next.close()
    return { ok: false, error: `Couldn't save the new port to ~/.traceroost/config.json: ${(err as Error).message}` }
  }
  // Long enough for the page that asked to read the answer and navigate away; its event stream
  // (and any other open tab's) is dropped with the old listener, and a tab still on the old
  // address gets "connection refused" — bookmarks need updating, which the page says.
  const old = opts.current
  setTimeout(() => {
    old.close()
    old.closeAllConnections()
  }, opts.closeDelayMs ?? 5_000).unref()
  return { ok: true, server: next }
}

/** The localStorage keys the dashboard keeps per origin — theme (media/src/state.ts), traces page
 *  size (state.ts) and agent profiles (media/src/agentProfiles.ts). Only these cross a move. */
export const CARRY_KEYS = ['traceroost-theme', 'traceroost-sessions-page-size', 'traceRoost.agentProfiles'] as const

/** Fragment key the page navigates with after a move: `#carry=<encodeURIComponent(JSON)>`, where
 *  the JSON is `{ moved: <port>, items: { <key>: <value> } }`. A fragment never reaches a server. */
export const CARRY_FRAGMENT = 'carry'

/**
 * The inline script (runs first in <head>, before the theme script reads localStorage) that takes
 * carried preferences out of the fragment: imports only CARRY_KEYS, string values only, then
 * drops the fragment from the address bar so a reload or a copied URL doesn't re-import. Records
 * the port moved to on `window.__DASHBOARD_MOVED_TO__` for the "moved" toast.
 */
export function carryImportScript(): string {
  return `(function () {
      try {
        var prefix = '#${CARRY_FRAGMENT}=';
        if (location.hash.indexOf(prefix) !== 0) return;
        var raw = location.hash.slice(prefix.length);
        history.replaceState(null, '', location.pathname + location.search);
        var data = JSON.parse(decodeURIComponent(raw));
        var allowed = ${JSON.stringify(CARRY_KEYS)};
        var items = (data && typeof data.items === 'object' && data.items) || {};
        for (var i = 0; i < allowed.length; i++) {
          var v = items[allowed[i]];
          if (typeof v === 'string') { try { localStorage.setItem(allowed[i], v); } catch (e) { /* storage unavailable */ } }
        }
        if (typeof data.moved === 'number') window.__DASHBOARD_MOVED_TO__ = data.moved;
      } catch (e) { /* malformed fragment — ignore it */ }
    })();`
}
