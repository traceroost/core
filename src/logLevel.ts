/**
 * Log verbosity, set by `TRACEROOST_LOG_LEVEL` (`info` by default, `debug` for routine
 * per-tick detail such as forwarding and trace-manifest counts). Read on every call so a test,
 * or a host that sets the variable late, takes effect without a restart. Any value other than
 * `debug` means `info`.
 */

export type LogLevel = 'debug' | 'info'

export function logLevel(): LogLevel {
  return process.env.TRACEROOST_LOG_LEVEL?.trim().toLowerCase() === 'debug' ? 'debug' : 'info'
}

/** Passes `msg` to `log` only at `debug` level. */
export function logDebug(log: ((msg: string) => void) | undefined, msg: string): void {
  if (log && logLevel() === 'debug') log(msg)
}
