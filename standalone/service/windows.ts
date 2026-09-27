import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  generateWindowsWrapperScript, WINDOWS_TASK_NAME, serviceLogPath, readServiceConfig, type ServiceProgram,
} from '../../src/serviceConfig'
import { probeServiceHealth } from './health'

function wrapperScriptPath(dataDir: string): string {
  return path.join(dataDir, 'service', 'run.cmd')
}

export function isInstalled(): boolean {
  try {
    execFileSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** `schtasks /end` returns before the task's process has fully exited and released its sockets,
 *  so a reinstall that immediately `/run`s a fresh instance can hit the old one still holding the
 *  UI/OTLP ports. Poll `schtasks /query` until the task reports it's no longer Running (bounded
 *  ~5s). This is the Windows analogue of macОS's bootout-and-wait. */
function endRunningInstanceAndWait(): void {
  try { execFileSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], { stdio: 'ignore' }) }
  catch { return }  // task doesn't exist yet — nothing to stop
  try { execFileSync('schtasks', ['/end', '/tn', WINDOWS_TASK_NAME], { stdio: 'ignore' }) } catch { /* wasn't running */ }
  for (let i = 0; i < 50; i++) {
    let out = ''
    try { out = execFileSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'list'], { encoding: 'utf-8' }) }
    catch { return }
    if (!/status:\s*running/i.test(out)) { return }
    sleepSync(100)
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function install(program: ServiceProgram): void {
  const scriptPath = wrapperScriptPath(program.config.dataDir)
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.mkdirSync(path.dirname(serviceLogPath(program.config)), { recursive: true })
  fs.writeFileSync(scriptPath, generateWindowsWrapperScript(program), 'utf-8')
  // Stop a running instance from a previous install first, so it releases the ports before the
  // fresh instance (started by /run below) tries to bind them.
  endRunningInstanceAndWait()
  // /f overwrites a pre-existing task of the same name (re-running install to change ports).
  // Capture stderr (rather than inherit) so index.ts's describeServiceManagerFailure can quote it.
  execFileSync('schtasks', [
    '/create', '/tn', WINDOWS_TASK_NAME, '/tr', `"${scriptPath}"`,
    '/sc', 'onlogon', '/rl', 'limited', '/f',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  // The logon trigger won't fire until next login — start it now too, for immediate feedback.
  try { execFileSync('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME], { stdio: 'ignore' }) } catch { /* best effort */ }
}

/** Idempotent, like the macOS/Linux uninstall: a task that's already gone (never installed, or
 *  removed by hand) isn't an error, and the wrapper script `install` wrote under the data dir
 *  from config.json is removed too. Also used as `service install`'s rollback — index.ts calls
 *  it before restoring the previous config.json, so it still sees the new install's data dir. */
export function uninstall(): void {
  if (isInstalled()) {
    try { execFileSync('schtasks', ['/end', '/tn', WINDOWS_TASK_NAME], { stdio: 'ignore' }) } catch { /* not running */ }
    execFileSync('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f'], { stdio: 'inherit' })
  }
  try { fs.rmSync(wrapperScriptPath(readServiceConfig().dataDir)) } catch { /* already removed */ }
}

export function start(): void {
  execFileSync('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME], { stdio: 'inherit' })
}

export function stop(): void {
  execFileSync('schtasks', ['/end', '/tn', WINDOWS_TASK_NAME], { stdio: 'inherit' })
}

export function restart(): void {
  endRunningInstanceAndWait()  // wait for the old instance to release its ports before /run
  start()
}

export async function status(uiPort: number, bindHost: string): Promise<boolean> {
  return probeServiceHealth(uiPort, bindHost)
}

export function logsPath(program: ServiceProgram): string {
  return serviceLogPath(program.config)
}
