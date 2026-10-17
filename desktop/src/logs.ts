/**
 * The desktop shell's log file, and its rotation.
 *
 * Logs stay on this machine. Nothing here is uploaded, and there is no crash reporter — the plan's
 * privacy invariants rule both out, and Electron's built-in crash reporting is left off in main.ts
 * rather than merely unconfigured.
 *
 * Rotation exists because this log holds the collector's stdout, which on a busy machine is a
 * steady trickle of ingestion lines, and the app may run for months without a restart. One
 * generation is kept: enough to still see what happened before the roll, without an unbounded pile
 * of files in a directory the user never looks at.
 */

import * as fs from 'fs'
import * as path from 'path'

export const MAX_LOG_BYTES = 5 * 1024 * 1024

export interface DesktopLog {
  filePath: string
  write: (line: string) => void
  /** The collector's stdout/stderr sink. Undefined if the log could not be opened. */
  stream: () => fs.WriteStream | undefined
  close: () => void
}

/** `<dataDir>/desktop.log`, beside the collector's own log, so "Open Logs" has one place to go and
 *  a support request has one file to ask for. */
export function desktopLogPath(dataDir: string): string {
  return path.join(dataDir, 'desktop.log')
}

/** Rolls `filePath` to `filePath.1` when it has grown past `maxBytes`, replacing any previous
 *  `.1`. Returns true if it rolled. Never throws — a log that cannot be rotated is not a reason to
 *  fail to start. */
export function rotateIfNeeded(filePath: string, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    if (fs.statSync(filePath).size <= maxBytes) return false
    fs.rmSync(`${filePath}.1`, { force: true })
    fs.renameSync(filePath, `${filePath}.1`)
    return true
  } catch {
    return false
  }
}

export function openDesktopLog(dataDir: string, maxBytes = MAX_LOG_BYTES): DesktopLog {
  const filePath = desktopLogPath(dataDir)
  let stream: fs.WriteStream | undefined
  try {
    // Owner-only: the collector's stdout can name the repositories and files a session touched.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    rotateIfNeeded(filePath, maxBytes)
    stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 })
    stream.on('error', () => { stream = undefined })
  } catch {
    stream = undefined
  }
  const write = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}\n`
    // Also to stdout, so `electron .` in a terminal during development shows the same thing.
    process.stdout.write(stamped)
    try { stream?.write(stamped) } catch { /* the stream's error handler has dropped it */ }
  }
  return {
    filePath,
    write,
    stream: () => stream,
    close: () => { try { stream?.end() } catch { /* closing anyway */ } },
  }
}
