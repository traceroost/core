/**
 * Which collector, if any, the desktop shell is allowed to attach to.
 *
 * The shell has exactly two modes (see mode.ts): it *owns* a collector it spawned itself, or it is
 * *attached* to one someone else started — the Homebrew/launchd background service, a `traceroost`
 * in a terminal, a Docker container on this data dir. Getting that wrong is the worst thing this
 * app can do: two writers on one data dir overwrite each other's `spans.json` (the whole reason
 * `standalone/dataDirLock.ts` exists), and a Quit that kills a service the user installed
 * separately is a data-losing surprise.
 *
 * So attachment is never inferred from "something answers on port 3000". The plan's requirement is
 * identity, data directory, version compatibility and endpoint ownership, and the evidence used
 * here is deliberately the writer's *own* record rather than anything self-reported over HTTP:
 *
 *   1. `<dataDir>/server.lock` — written by the writer itself, holding pid, hostname, start time,
 *      whether it is the background service, the ports it actually bound, and (since the field was
 *      added alongside this shell) its version. A process that does not hold this lock is not the
 *      writer, whatever it serves.
 *   2. the holder is alive, on this host — a lock whose pid is gone is a crashed holder's leftover,
 *      which means the dir is free, not that a collector is running.
 *   3. an unauthenticated identity probe on the bound OTLP port — proves the process still listening
 *      there is a TraceRoost standalone collector and not some unrelated app that grabbed a recycled
 *      port after the lock was written.
 *
 * `/health` is not used for any of this: it answers `{status:'ok'}` with no identity at all, so it
 * cannot distinguish a TraceRoost collector from anything else that returns 200.
 *
 * Nothing here spawns, signals or writes anything. It reads and reports; mode.ts decides.
 */

import * as path from 'path'
import { LOCK_FILENAME, type DataDirLockInfo } from '../../standalone/dataDirLock'

/** What the shell learned about the collector holding a data dir. */
export interface CollectorIdentity {
  pid: number
  hostname: string
  startedAt: string
  /** True when the holder is the OS-native background service (launchd here, Scheduled Task on
   *  Windows) — the case where Quit must never stop it and restart controls stay unavailable. */
  service: boolean
  uiPort: number
  otlpPort: number
  mcpPort: number
  /** Undefined when the holder predates the lock's `version` field. */
  version: string | undefined
}

export type AttachRefusal =
  /** No lock at all: the data dir has no writer, so the shell may start its own collector. */
  | 'no-collector'
  /** A lock whose holder's pid is gone — a crashed collector's leftover. Also a free data dir. */
  | 'stale-lock'
  /** The lock exists but is still being written by a starting holder. Transient; re-check. */
  | 'starting'
  /** A holder on a different machine (a data dir on shared or network storage). Not ours to own
   *  or to stop, and its ports are on that machine, so there is nothing here to attach to. */
  | 'other-host'
  /** Holding the lock but not yet listening — it has not bound its ports. Transient. */
  | 'ports-unbound'
  /** Something is on the bound OTLP port, but it does not identify as a standalone collector. */
  | 'not-traceroost'
  /** A major version this shell does not know how to share a data dir with. */
  | 'version-incompatible'

export type AttachVerdict =
  /** Attach freely: identity, host, liveness, ports and endpoint ownership all check out, and the
   *  holder's version is known and compatible. */
  | { ok: true; needsConfirmation: false; identity: CollectorIdentity }
  /** Everything checks out except the version, which the holder does not publish (a release from
   *  before the lock carried one). Attaching is very probably right — but "probably" is not a
   *  validated version, so this is surfaced for an explicit user act rather than done silently. */
  | { ok: true; needsConfirmation: true; unverified: 'version-unknown'; identity: CollectorIdentity }
  | { ok: false; reason: AttachRefusal; detail: string; identity?: Partial<CollectorIdentity> }

/** True when the data dir has no live writer, so starting an owned collector is the right move.
 *  Distinct from the transient and foreign refusals, where starting one would create a second
 *  writer or race a holder that is still coming up. */
export function meansDataDirIsFree(reason: AttachRefusal): boolean {
  return reason === 'no-collector' || reason === 'stale-lock'
}

/** The pieces of the outside world this module reads — injected so the decision table is testable
 *  without a real collector, a real lock file or a real socket. */
export interface HandshakeEnv {
  /** Raw contents of a path, or undefined if it does not exist / cannot be read. */
  readFile: (filePath: string) => string | undefined
  /** mtime of a path in ms, or undefined. Used only to age an unparseable lock. */
  mtimeMs: (filePath: string) => number | undefined
  hostname: string
  now: () => number
  isPidAlive: (pid: number) => boolean
  /** Resolves what is listening on an OTLP port: a standalone collector, the VS Code extension's
   *  own collector, or something else. `standalone/../src/portResolver.ts#detectPortOwner`. */
  probeOtlpOwner: (port: number) => Promise<'plugin' | 'standalone' | 'foreign'>
}

/** An empty or half-written lock younger than this is a holder mid-startup, not a corrupt file.
 *  Matches `dataDirLock.ts`'s own grace period for the same condition. */
const UNREADABLE_GRACE_MS = 10_000

/**
 * The version rule. Same major version attaches; a different major does not.
 *
 * A shared data dir is a shared on-disk format, and the major is the only signal here about
 * whether two builds agree on it. This is deliberately not "newer is fine": the danger runs in
 * both directions — an older shell attaching to a newer collector reads a store it may not
 * understand, and the reverse is the migrated-data-with-an-older-collector case the plan's Stage 4
 * calls out. Pre-1.0 versions are judged on major.minor, because that is where this project's
 * breaking changes actually land while the major is pinned at 0.
 */
export function versionsCompatible(ours: string, theirs: string): boolean {
  const parse = (v: string) => {
    const [major, minor] = v.replace(/^v/, '').split('.')
    return { major: Number(major), minor: Number(minor) }
  }
  const a = parse(ours)
  const b = parse(theirs)
  if (!Number.isFinite(a.major) || !Number.isFinite(b.major)) return false
  if (a.major !== b.major) return false
  if (a.major === 0) return Number.isFinite(a.minor) && Number.isFinite(b.minor) && a.minor === b.minor
  return true
}

function readLock(dataDir: string, env: HandshakeEnv): { info: DataDirLockInfo | null; ageMs: number } | undefined {
  const lockPath = path.join(dataDir, LOCK_FILENAME)
  const raw = env.readFile(lockPath)
  if (raw === undefined) return undefined
  const ageMs = env.now() - (env.mtimeMs(lockPath) ?? env.now())
  try {
    const parsed = JSON.parse(raw) as Partial<DataDirLockInfo>
    const valid = typeof parsed.pid === 'number' && typeof parsed.hostname === 'string' && typeof parsed.token === 'string'
    return { info: valid ? (parsed as DataDirLockInfo) : null, ageMs }
  } catch {
    return { info: null, ageMs }
  }
}

/**
 * Decides whether the shell may attach to whatever holds `dataDir`.
 *
 * `ourVersion` is the desktop shell's own package version — the one its bundled collector would
 * run if it started one.
 */
export async function inspectCollector(
  dataDir: string,
  ourVersion: string,
  env: HandshakeEnv,
): Promise<AttachVerdict> {
  const lock = readLock(dataDir, env)
  if (lock === undefined) {
    return { ok: false, reason: 'no-collector', detail: `No collector holds ${dataDir}.` }
  }
  if (lock.info === null) {
    // Mid-write by a starting holder, or a genuinely corrupt file. Either way this shell must not
    // start a second writer on the strength of an unreadable lock; dataDirLock.ts's own takeover
    // logic is what clears a corrupt one, on the collector's next start.
    return lock.ageMs > UNREADABLE_GRACE_MS
      ? { ok: false, reason: 'starting', detail: `The lock in ${dataDir} cannot be read and has not changed in ${Math.round(lock.ageMs / 1000)}s.` }
      : { ok: false, reason: 'starting', detail: 'A collector is starting up right now.' }
  }

  const held = lock.info
  const sameHost = held.hostname.toLowerCase() === env.hostname.toLowerCase()
  if (!sameHost) {
    return {
      ok: false,
      reason: 'other-host',
      detail: `${dataDir} is held by pid ${held.pid} on ${held.hostname}. The data directory is shared between machines; this app can neither attach to nor stop a collector running elsewhere.`,
      identity: { pid: held.pid, hostname: held.hostname, version: held.version },
    }
  }
  if (!env.isPidAlive(held.pid)) {
    return {
      ok: false,
      reason: 'stale-lock',
      detail: `${dataDir} has a leftover lock from pid ${held.pid}, which is no longer running.`,
      identity: { pid: held.pid, hostname: held.hostname, version: held.version },
    }
  }
  if (held.uiPort === undefined || held.otlpPort === undefined || held.mcpPort === undefined) {
    return {
      ok: false,
      reason: 'ports-unbound',
      detail: `pid ${held.pid} holds ${dataDir} but has not finished binding its ports.`,
      identity: { pid: held.pid, hostname: held.hostname },
    }
  }

  const identity: CollectorIdentity = {
    pid: held.pid,
    hostname: held.hostname,
    startedAt: held.startedAt,
    service: held.service === true,
    uiPort: held.uiPort,
    otlpPort: held.otlpPort,
    mcpPort: held.mcpPort,
    version: held.version,
  }

  // Endpoint ownership. The lock says which ports that pid bound; this confirms a standalone
  // collector is still the thing answering on one of them. A 'plugin' answer means the VS Code
  // extension's collector took the port — it keeps its spans in VS Code's own storage, so it is
  // not this data dir's writer and not something to attach to.
  const owner = await env.probeOtlpOwner(identity.otlpPort)
  if (owner !== 'standalone') {
    return {
      ok: false,
      reason: 'not-traceroost',
      detail: owner === 'plugin'
        ? `Port ${identity.otlpPort} is answering as the VS Code extension's collector, not the standalone collector that holds ${dataDir}.`
        : `Nothing on port ${identity.otlpPort} identifies as a TraceRoost collector, though pid ${identity.pid} holds ${dataDir}.`,
      identity,
    }
  }

  if (identity.version === undefined) {
    return { ok: true, needsConfirmation: true, unverified: 'version-unknown', identity }
  }
  if (!versionsCompatible(ourVersion, identity.version)) {
    return {
      ok: false,
      reason: 'version-incompatible',
      detail: `The collector on ${dataDir} is version ${identity.version}; this app is ${ourVersion}. Sharing a data directory between these is not supported — update whichever is older.`,
      identity,
    }
  }
  return { ok: true, needsConfirmation: false, identity }
}

/** One line for the tray's status item and the log. */
export function describeVerdict(verdict: AttachVerdict): string {
  if (verdict.ok) {
    const { identity } = verdict
    const who = identity.service ? 'background service' : `pid ${identity.pid}`
    const version = identity.version ?? 'unknown version'
    return verdict.needsConfirmation
      ? `Found a running collector (${who}, ${version}) — confirm before attaching`
      : `Attached to the running collector (${who}, ${version}) on port ${identity.uiPort}`
  }
  return verdict.detail
}
