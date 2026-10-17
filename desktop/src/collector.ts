/**
 * The owned collector: one supervised child process, never in the renderer and never in the main
 * process.
 *
 * Why a child at all, when Electron's main process is already Node: the collector is a long-lived
 * writer with its own `process.on('exit')` flush, its own data-dir lock heartbeat and its own
 * last-resort error handlers (`standalone/server.ts`). Hosting it in-process would put all of that
 * in the same process as a Chromium window — a renderer crash or a window-close path could take
 * the writer down mid-save, and the collector's `process.exit(0)` on SIGTERM would quit the app.
 * As a child it keeps exactly the lifecycle it has when run from a terminal or by launchd.
 *
 * Readiness is not inferred from the child's stdout. It is read from the data-dir lock the child
 * itself writes: once the lock names the child's pid *and* carries bound ports, the collector is
 * up and those are the ports it actually got. That matters because the collector scans upward from
 * its configured port when one is taken (`src/portResolver.ts`), so the configured port and the
 * live port are different questions — the plan calls a shell that confused the two a "silent port
 * change", and reading the writer's own record is what prevents it.
 */

import { type ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { LOCK_FILENAME, type DataDirLockInfo } from '../../standalone/dataDirLock'
import { countsAsCrashLoop, restartDelayMs, shouldKeepRestarting } from './backoff'

export type CollectorState =
  | { status: 'stopped' }
  | { status: 'starting'; pid?: number }
  | { status: 'running'; pid: number; uiPort: number; otlpPort: number; mcpPort: number }
  /** Waiting out the backoff delay before another attempt. */
  | { status: 'restarting'; attempt: number; nextAttemptInMs: number; lastError: string }
  /** Gave up after MAX_CONSECUTIVE_FAILURES. Only a manual Start/Restart leaves this state. */
  | { status: 'failed'; lastError: string }

/** The one state that carries ports — what a successful start resolves to. */
export type RunningCollector = Extract<CollectorState, { status: 'running' }>

export interface CollectorOptions {
  /** Absolute path to the staged `standalone/server.js`. */
  serverScript: string
  /** The runtime to run it with — Electron's own binary, re-entered as Node. */
  execPath: string
  /** The data dir the collector will lock and write to. */
  dataDir: string
  /** Extra environment for the child, merged over a copy of the shell's own. */
  env?: Record<string, string | undefined>
  log: (line: string) => void
  /** Where the collector's stdout/stderr go. */
  logStream?: () => fs.WriteStream | undefined
  platform?: NodeJS.Platform
}

/** How long to wait for the child to claim the lock with bound ports before calling the start a
 *  failure. The collector binds within a second or two; a slow disk or a port scan can stretch it. */
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 150

/** After asking the collector to shut down, how long to let it flush before it is killed outright.
 *  Its SIGTERM handler saves spans.json and the outcomes cache and then exits, which is fast — but
 *  a large store on a slow disk should not be cut off mid-write. */
const GRACEFUL_STOP_MS = 10_000

export class OwnedCollector {
  private child: ChildProcess | undefined
  private state: CollectorState = { status: 'stopped' }
  private consecutiveFailures = 0
  private startedAt = 0
  private restartTimer: NodeJS.Timeout | undefined
  /** Set while a deliberate stop is in flight, so the exit handler does not treat it as a crash. */
  private stopping = false
  private readonly listeners = new Set<(state: CollectorState) => void>()
  private readonly platform: NodeJS.Platform

  constructor(private readonly opts: CollectorOptions) {
    this.platform = opts.platform ?? process.platform
  }

  current(): CollectorState { return this.state }

  onStateChange(listener: (state: CollectorState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(next: CollectorState): void {
    this.state = next
    for (const listener of this.listeners) {
      try { listener(next) } catch (e) { this.opts.log(`[desktop] a state listener threw: ${String(e)}`) }
    }
  }

  /**
   * Starts the collector and resolves once it holds the data-dir lock with bound ports, or rejects
   * if it exits or never becomes ready. A manual start clears a previous `failed` state and resets
   * the backoff — the user asking again means something may have changed.
   */
  async start(): Promise<CollectorState> {
    if (this.child) return this.state
    this.clearRestartTimer()
    this.consecutiveFailures = 0
    return this.spawnOnce()
  }

  private async spawnOnce(): Promise<CollectorState> {
    this.stopping = false
    this.setState({ status: 'starting' })

    const stream = this.opts.logStream?.()
    const child = spawn(this.opts.execPath, [this.opts.serverScript], {
      cwd: path.dirname(this.opts.serverScript),
      env: {
        ...process.env,
        ...this.opts.env,
        // Re-enter Electron's binary as plain Node: no Chromium, no app lifecycle, just the
        // collector. Electron 44 bundles Node 24, which is what the collector requires.
        ELECTRON_RUN_AS_NODE: '1',
        DATA_DIR: this.opts.dataDir,
        // Deliberately *not* TRACEROOST_SERVICE=1. That flag means "I am the OS background
        // service": it makes the collector wait indefinitely for a busy data dir instead of
        // refusing, and it writes the service process record that `traceroost service stop` acts
        // on. An app-owned collector is neither of those things, and claiming to be would let
        // `service stop` reach into this app's child.
        TRACEROOST_SERVICE: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.startedAt = Date.now()
    this.setState({ status: 'starting', pid: child.pid })
    this.opts.log(`[desktop] collector starting — pid ${child.pid ?? '?'}, data dir ${this.opts.dataDir}`)

    // The collector's own logging is the only record of why a start failed, so it is captured
    // whether or not a log file is open. Never parsed for state — see the readiness note above.
    const tail: string[] = []
    const capture = (chunk: Buffer) => {
      const text = chunk.toString()
      stream?.write(text)
      tail.push(text)
      if (tail.length > 40) tail.shift()
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    const exitPromise = new Promise<void>(resolve => {
      child.once('exit', (code, signal) => { exited = { code, signal }; resolve() })
      child.once('error', err => { exited = { code: null, signal: null }; this.opts.log(`[desktop] collector could not be spawned: ${err.message}`); resolve() })
    })

    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      const uptimeMs = Date.now() - this.startedAt
      if (this.stopping) {
        this.opts.log(`[desktop] collector stopped (code ${code ?? 'none'}, signal ${signal ?? 'none'})`)
        this.setState({ status: 'stopped' })
        return
      }
      const detail = `collector exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'})`
      this.opts.log(`[desktop] ${detail} after ${Math.round(uptimeMs / 1000)}s`)
      this.scheduleRestart(detail, uptimeMs)
    })

    const ready = await Promise.race([
      this.waitForLock(child, exitPromise),
      exitPromise.then(() => undefined),
    ])

    if (ready) {
      // Not a reason to reset consecutiveFailures: a collector that binds its ports and crashes a
      // moment later is still crash-looping. scheduleRestart resets it once a run lasted
      // HEALTHY_UPTIME_MS; a manual start or restart resets it too.
      this.setState(ready)
      this.opts.log(`[desktop] collector ready — dashboard on port ${ready.uiPort}, OTLP ${ready.otlpPort}, MCP ${ready.mcpPort}`)
      return ready
    }

    const why = exited
      ? `the collector exited during startup (code ${exited.code ?? 'none'}, signal ${exited.signal ?? 'none'})`
      : `the collector did not become ready within ${READY_TIMEOUT_MS / 1000}s`
    throw new Error(`${why}${tail.length ? `\n${tail.join('').trimEnd().split('\n').slice(-10).join('\n')}` : ''}`)
  }

  /** Polls the data-dir lock until it names this child with bound ports. */
  private async waitForLock(child: ChildProcess, exited: Promise<void>): Promise<RunningCollector | undefined> {
    const lockPath = path.join(this.opts.dataDir, LOCK_FILENAME)
    const deadline = Date.now() + READY_TIMEOUT_MS
    let done = false
    void exited.then(() => { done = true })
    while (!done && Date.now() < deadline) {
      const held = readLockInfo(lockPath)
      if (held && held.pid === child.pid && held.uiPort !== undefined && held.otlpPort !== undefined && held.mcpPort !== undefined) {
        return { status: 'running', pid: held.pid, uiPort: held.uiPort, otlpPort: held.otlpPort, mcpPort: held.mcpPort }
      }
      await delay(READY_POLL_MS)
    }
    return undefined
  }

  private scheduleRestart(detail: string, uptimeMs: number): void {
    if (!countsAsCrashLoop(uptimeMs)) {
      // It ran long enough to count as having worked. Treat this exit as the first failure of a
      // new problem rather than the next step of an old one.
      this.consecutiveFailures = 0
    }
    this.consecutiveFailures += 1
    if (!shouldKeepRestarting(this.consecutiveFailures)) {
      this.opts.log(`[desktop] giving up after ${this.consecutiveFailures} consecutive failures — collection is stopped until you start it again`)
      this.setState({ status: 'failed', lastError: detail })
      return
    }
    const wait = restartDelayMs(this.consecutiveFailures)
    this.setState({ status: 'restarting', attempt: this.consecutiveFailures, nextAttemptInMs: wait, lastError: detail })
    this.opts.log(`[desktop] restarting the collector in ${wait / 1000}s (attempt ${this.consecutiveFailures})`)
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.spawnOnce().catch(err => {
        // spawnOnce's rejection is the startup path; the 'exit' handler has already scheduled the
        // next attempt (or given up), so this only needs to be recorded.
        this.opts.log(`[desktop] restart attempt failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }, wait)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined }
  }

  /**
   * Asks the collector to shut down and waits for it to flush.
   *
   * On POSIX this is SIGTERM, which the collector handles: it saves spans.json and the outcomes
   * cache, releases the data-dir lock from its 'exit' handler, and exits 0. A child that has not
   * gone within GRACEFUL_STOP_MS is killed — at that point it is wedged, and the stores are atomic
   * per write (`src/fsAtomic.ts`), so what is on disk is consistent either way.
   *
   * Windows has no SIGTERM: `child.kill()` there is TerminateProcess, which runs no handler and so
   * loses whatever had not been saved. Rather than pretend otherwise, owned mode is refused on
   * win32 (see main.ts) until the Windows feature adds a cooperative shutdown channel — its own
   * plan names this as the work. Attached mode is unaffected: it never stops anything.
   */
  async stop(): Promise<void> {
    this.clearRestartTimer()
    const child = this.child
    if (!child) { this.setState({ status: 'stopped' }); return }
    this.stopping = true
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    if (this.platform === 'win32') {
      throw new Error('Stopping an app-owned collector is not supported on Windows in this build — see .staged-features/windows-desktop-tray-app.md')
    }
    this.opts.log(`[desktop] asking the collector (pid ${child.pid ?? '?'}) to shut down`)
    child.kill('SIGTERM')
    const flushed = await Promise.race([exited.then(() => true), delay(GRACEFUL_STOP_MS).then(() => false)])
    if (!flushed) {
      this.opts.log('[desktop] the collector did not exit in time — killing it')
      child.kill('SIGKILL')
      await Promise.race([exited, delay(2_000)])
    }
    this.child = undefined
    this.setState({ status: 'stopped' })
  }

  async restart(): Promise<CollectorState> {
    await this.stop()
    this.consecutiveFailures = 0
    return this.spawnOnce()
  }

  /** True while a child is alive — used by the quit path to decide whether to flush. */
  isOwning(): boolean { return this.child !== undefined }
}

function readLockInfo(lockPath: string): DataDirLockInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<DataDirLockInfo>
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return undefined
    return parsed as DataDirLockInfo
  } catch {
    return undefined
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
