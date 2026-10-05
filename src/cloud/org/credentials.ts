/**
 * Storage for the linked-machine credential (AL 01).
 *
 * The credential lives in `~/.traceroost/team.json` with user-only permissions (0600). A real OS
 * keychain is the preferred store, but the file fallback is *always* kept — keychains are absent
 * in containers, CI and headless boxes, which is exactly where linking a machine matters. Rather
 * than pull a native dependency (`keytar` and friends drag a build toolchain into a
 * pure-TypeScript extension), the backend is abstracted behind `CredentialStore` so a keychain
 * implementation can be slotted in later without touching a caller.
 *
 * Nothing here is ever called on an unlinked install except `loadCredentials`, which returns
 * `null` and touches nothing else. That is what makes "an unlinked install makes no requests to
 * the service at all" a structural property rather than a policy.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { OrgCredentials } from './config'
import { refreshCredentials } from './tokenRefresh'

export function traceroostDir(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost')
}

export function credentialsPath(baseHome?: string): string {
  return path.join(traceroostDir(baseHome), 'team.json')
}

export interface CredentialStore {
  load(): OrgCredentials | null
  save(creds: OrgCredentials): void
  clear(): void
  /** The on-disk file every host on this machine shares, if any — `tokenRefresh.ts` locks it
   *  around a refresh-then-save. Absent for a store with nothing shared to lock (tests' in-memory
   *  stores). */
  lockTarget?: string
}

/** File-backed store. `baseHome` is injectable so tests never touch a real home directory. */
export function fileCredentialStore(baseHome?: string): CredentialStore {
  const file = credentialsPath(baseHome)
  return {
    lockTarget: file,
    load() {
      try {
        const raw = fs.readFileSync(file, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<OrgCredentials> & { role?: unknown }
        const role = normalizeRole(parsed.role)
        if (!role) return null
        const creds = { ...parsed, role }
        if (!isCompleteCredential(creds)) return null
        return creds
      } catch {
        return null
      }
    },
    save(creds) {
      const dir = path.dirname(file)
      fs.mkdirSync(dir, { recursive: true })
      // Write to a temp file then rename, so a crash mid-write can't leave a half-written
      // credential that parses as valid. 0600 from creation — never world-readable, not even
      // for a moment.
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, file)
    },
    clear() {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* already gone — leaving is idempotent by design */
      }
    },
  }
}

let activeStore: CredentialStore | undefined

/** The process-wide store. Overridable in tests via `setCredentialStore`. */
export function credentialStore(): CredentialStore {
  if (!activeStore) activeStore = fileCredentialStore()
  return activeStore
}

export function setCredentialStore(store: CredentialStore | undefined): void {
  activeStore = store
}

/** Returns the linked-machine credential, or `null` if this machine is not linked. The single
 *  entry point every other module uses to answer "is this machine linked to Cloud?". */
export function loadCredentials(): OrgCredentials | null {
  return credentialStore().load()
}

export function saveCredentials(creds: OrgCredentials): void {
  credentialStore().save(creds)
}

/** Deletes the local credential. Local-first: callers stop forwarding immediately and only
 *  then attempt the server-side revoke, so leaving works with the machine offline. */
export function clearCredentials(): void {
  credentialStore().clear()
}

export function isLinked(): boolean {
  return loadCredentials() !== null
}

/** The server's two roles are `admin` and `developer` (cloud migration 0031 renamed `lead` →
 *  `admin`). A credential file written before that says `lead` / `member` — read those as the
 *  roles they always meant rather than rejecting an otherwise-valid credential; the next roster
 *  lookup (`link.ts`'s `refreshOrgNameIfStale`) rewrites it in the current vocabulary. */
function normalizeRole(role: unknown): OrgCredentials['role'] | null {
  if (role === 'admin' || role === 'lead') return 'admin'
  if (role === 'developer' || role === 'member') return 'developer'
  return null
}

/**
 * Self-heal for a credential written before `installId` existed. `deliveryLedger.ts` needs it
 * to scope "already delivered" correctly (see its doc comment); a credential lacking it just
 * means this call hasn't succeeded yet, here or at link time — never a reason to reject an
 * otherwise-valid credential file.
 *
 * A no-op the instant it has ever once succeeded. On failure (offline, revoked), returns `creds`
 * unchanged — callers that need `installId` degrade gracefully without it (see
 * `enqueueSession.ts` and `sender.ts`), so there's nothing to retry here specifically; the next
 * opportunistic call (or drain) tries again.
 */
export async function ensureInstallId(creds: OrgCredentials): Promise<OrgCredentials> {
  if (creds.installId) return creds
  try {
    // Through the locked refresh (tokenRefresh.ts), which also fills in `installId` from the
    // token response — a bare refresh here could race another host's and unlink this machine.
    return await refreshCredentials(creds)
  } catch {
    return creds
  }
}

function isCompleteCredential(c: Partial<OrgCredentials>): c is OrgCredentials {
  return (
    typeof c.endpoint === 'string' &&
    typeof c.orgId === 'string' &&
    typeof c.orgName === 'string' &&
    typeof c.memberId === 'string' &&
    (c.role === 'admin' || c.role === 'developer') &&
    typeof c.perDeveloperVisibility === 'boolean' &&
    typeof c.accessToken === 'string' &&
    typeof c.refreshToken === 'string' &&
    typeof c.accessTokenExpiresAt === 'number' &&
    typeof c.linkedAt === 'string'
  )
}
