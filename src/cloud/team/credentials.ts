/**
 * Storage for the linked-machine credential (AL 01).
 *
 * The credential lives in `~/.agentlens/team.json` with user-only permissions (0600). A real OS
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
import type { TeamCredentials } from './config'

export function agentlensDir(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.agentlens')
}

export function credentialsPath(baseHome?: string): string {
  return path.join(agentlensDir(baseHome), 'team.json')
}

export interface CredentialStore {
  load(): TeamCredentials | null
  save(creds: TeamCredentials): void
  clear(): void
}

/** File-backed store. `baseHome` is injectable so tests never touch a real home directory. */
export function fileCredentialStore(baseHome?: string): CredentialStore {
  const file = credentialsPath(baseHome)
  return {
    load() {
      try {
        const raw = fs.readFileSync(file, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<TeamCredentials>
        if (!isCompleteCredential(parsed)) return null
        return parsed
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
 *  entry point every other module uses to answer "are we Pro?". */
export function loadCredentials(): TeamCredentials | null {
  return credentialStore().load()
}

export function saveCredentials(creds: TeamCredentials): void {
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

function isCompleteCredential(c: Partial<TeamCredentials>): c is TeamCredentials {
  return (
    typeof c.endpoint === 'string' &&
    typeof c.orgId === 'string' &&
    typeof c.orgName === 'string' &&
    typeof c.memberId === 'string' &&
    (c.role === 'lead' || c.role === 'member') &&
    typeof c.perDeveloperVisibility === 'boolean' &&
    typeof c.accessToken === 'string' &&
    typeof c.refreshToken === 'string' &&
    typeof c.accessTokenExpiresAt === 'number' &&
    typeof c.linkedAt === 'string'
  )
}
