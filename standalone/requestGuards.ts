/**
 * Small, pure request-handling guards for standalone/server.ts, kept out of it so they can be
 * unit tested (the server module starts listening on import).
 */

/**
 * `decodeURIComponent` that never throws. A malformed escape (`%E0%A4%A`) makes the built-in
 * throw a URIError — inside an `http` request listener that is an uncaught exception that takes
 * the whole server down, and a GET path is reachable from any web page the developer has open
 * (`<img src="http://localhost:3000/api/timeline/%E0%A4%A">`; the Origin check only covers
 * non-GET). Returns null for input that doesn't decode; the route answers 400.
 */
export function decodePathSegment(raw: string): string | null {
  try { return decodeURIComponent(raw) } catch { return null }
}

/** Placeholder the redacted dashboard URL carries instead of the token. */
export const REDACTED_TOKEN = '<token>'

/**
 * The dashboard URL with its `token` query value replaced by a placeholder. When the server runs as
 * a background service its stdout is the service log (`~/.traceroost/logs/service.log`) — printing
 * the full URL there would leave the bearer token in a plain log file. The real URL still reaches
 * the browser (auto-open) and `traceroost service status`.
 */
export function redactTokenInUrl(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/g, `$1${REDACTED_TOKEN}`)
}

/**
 * Whether the full token-bearing URL may be printed to stdout: only in an interactive terminal
 * (where the person reading it is the one who owns the token), never when running as the
 * background service (stdout is a log file) or with stdout redirected (a pipe, Docker logs).
 */
export function mayPrintFullUrl(env: { service: boolean; stdoutIsTty: boolean }): boolean {
  return !env.service && env.stdoutIsTty
}
