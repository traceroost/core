/**
 * Which TraceRoost host on this machine is talking to the cloud (stable trace identity, feature
 * 11 — the trace manifest's host tag).
 *
 * The editor extension and the standalone server share one cloud credential (`~/.traceroost/
 * team.json`, one install) but each keeps its own trace store — the extension in its VS Code
 * global storage, the server in its data directory — and an OTEL-only trace lands in whichever
 * host's collector received it. So every rollup and every manifest chunk carries `host_id`, and
 * the cloud retires only rows whose last sender was the manifest's own host: a manifest from one
 * host can never retire a trace only the other one saw.
 *
 * The id is a random UUID generated once per host store and kept in that store
 * (`<store>/cloud-host-id`) — never derived from a hostname, a path or anything else identifying.
 * Every process that shares a store (several VS Code windows on one global storage) shares its id,
 * which is right: they share one trace history. It is created lazily, the first time a linked
 * install builds a payload or a manifest, so an install that is never linked never writes it.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const HOST_ID_FILE = 'cloud-host-id'

/** What an unlinked install's payload preview shows — nothing is ever sent with it, and showing
 *  it never writes a file. */
export const PREVIEW_HOST_ID = '00000000-0000-4000-8000-000000000000'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function readHostId(file: string): string | null {
  try {
    const id = fs.readFileSync(file, 'utf-8').trim().toLowerCase()
    return UUID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/** The host id kept in `storeDir`, generating and persisting one on first use. Safe against
 *  another process sharing the store doing the same at the same moment: the file is published
 *  with an exclusive link, so exactly one id wins and both return it. */
export function loadOrCreateHostId(storeDir: string): string {
  const file = path.join(storeDir, HOST_ID_FILE)
  const existing = readHostId(file)
  if (existing) return existing
  const id = crypto.randomUUID()
  fs.mkdirSync(storeDir, { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, id + '\n', { mode: 0o600 })
  try {
    fs.linkSync(tmp, file)
    return id
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    // Someone else published first — theirs wins. An unreadable/corrupt file is replaced: a new
    // id only means rows sent under the old one are never retired by a manifest (the safe side).
    const winner = readHostId(file)
    if (winner) return winner
    fs.renameSync(tmp, file)
    return id
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* already moved or gone */ }
  }
}

let hostStoreDir: string | undefined
let cachedId: string | undefined
let processId: string | undefined

/** Names this process's trace store. Each host calls it once at startup, before anything is
 *  enqueued: the extension with its global storage directory, the standalone server with its data
 *  directory. Touches nothing on disk. */
export function setHostStore(storeDir: string | undefined): void {
  if (storeDir === hostStoreDir) return
  hostStoreDir = storeDir
  cachedId = undefined
}

/** This host's id. A process that never named its store (a test, a one-off script) gets an id of
 *  its own for its lifetime — its manifest can never retire anything another process sent. */
export function currentHostId(): string {
  if (!hostStoreDir) return (processId ??= crypto.randomUUID())
  return (cachedId ??= loadOrCreateHostId(hostStoreDir))
}
