/**
 * Per-owner wire ids for traces somebody else already holds in TraceRoost Cloud.
 *
 * A session's wire `session_id` is `toUuid` of its local key (traceIdentity.ts), and the cloud's
 * `rollups.session_id` is that table's only key: one row per id across every org. So once a
 * machine has sent a trace while linked as one developer, nobody else can ever hold it under that
 * id. A machine unlinked and re-linked as another developer (or to another org, or another
 * environment's org) sends the same ids, and the cloud refuses them all. It used to answer that
 * refusal as a duplicate, which core records as delivered: the panel said everything was synced
 * while the new developer's dashboard stayed empty.
 *
 * The cloud now answers it as `409 session_owned_elsewhere`, to a client that says it understands
 * it (`ACCEPTS_HEADER`). sender.ts then records the session here for the linked owner (org +
 * member) and re-sends it under `ownerSessionId`, an id salted with that owner. Only refused
 * sessions move: every other trace keeps its plain id, so a same-member re-link still re-attributes
 * its existing rows (cloud migration 0004) instead of duplicating them.
 *
 * Every place that turns a local key into a wire id for the linked owner goes through `wireId`:
 * the payload build (payloadPreview.ts), the delivery-ledger check (enqueueSession.ts), the trace
 * manifest's key list (traceManifest.ts), cluster resolution and the cloud→local hand-off.
 *
 * Stored in `~/.traceroost/rekeyed.json` (same shape and cap as the delivery ledger). Not cleared
 * on leave: the entries are scoped by owner, so they only ever apply to that owner again. Losing
 * one is harmless — the session goes out under its plain id, is refused again, and is re-keyed.
 */

import * as os from 'os'
import * as path from 'path'
import { DeliveryLedger, DEFAULT_MAX_ENTRIES } from './deliveryLedger'
import { toUuid } from '../../traceIdentity'

/** The `error` of a per-record 409 from cloud `/api/ingest` and `/api/ingest/batch`. */
export const SESSION_OWNED_ELSEWHERE = 'session_owned_elsewhere'
/** The request header (and its value) that opts in to `SESSION_OWNED_ELSEWHERE`. Without it the
 *  cloud keeps answering such a session as a duplicate, which an older core relies on. */
export const ACCEPTS_HEADER = 'X-TraceRoost-Accepts'
export const ACCEPTS_OWNER_CONFLICT = 'session-owner-conflict'

/** Who a re-keyed id belongs to — the linked credential's org and member. */
export interface SessionOwner {
  orgId: string
  memberId: string
}

export function rekeyLedgerPath(baseHome: string = os.homedir()): string {
  return path.join(baseHome, '.traceroost', 'rekeyed.json')
}

/** The id `sessionId` (a plain wire id) goes out under for `owner` once it has been re-keyed. */
export function ownerSessionId(owner: SessionOwner, sessionId: string): string {
  return toUuid(`owner:${owner.orgId}:${owner.memberId}:${sessionId.toLowerCase()}`)
}

function entryPrefix(owner: SessionOwner): string {
  return `${owner.orgId}:${owner.memberId}:`
}

export class RekeyLedger {
  private readonly ledger: DeliveryLedger

  constructor(baseHome?: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.ledger = new DeliveryLedger(baseHome, maxEntries, rekeyLedgerPath(baseHome))
  }

  /** The wire id for plain wire id `sessionId` under `owner`: its owner id once re-keyed, else
   *  itself. */
  wireId(owner: SessionOwner, sessionId: string): string {
    return this.ledger.isDelivered(entryPrefix(owner) + sessionId.toLowerCase()) ? ownerSessionId(owner, sessionId) : sessionId
  }

  markRekeyed(owner: SessionOwner, sessionId: string): void {
    this.ledger.markDeliveredMany([entryPrefix(owner) + sessionId.toLowerCase()])
  }

  /** Whether `wireId` is already an owner id minted for `owner`. The cloud refusing one of those
   *  means someone else holds the salted id too, so salting again won't help: sender.ts drops it
   *  rather than re-keying in a loop. Walks this owner's entries — only ever asked on a refusal. */
  isOwnerId(owner: SessionOwner, wireId: string): boolean {
    const prefix = entryPrefix(owner)
    const want = wireId.toLowerCase()
    return this.ledger.all().some(key => key.startsWith(prefix) && ownerSessionId(owner, key.slice(prefix.length)) === want)
  }
}

/** `wireId` for the linked owner, or the plain id itself with no owner (unlinked). */
export function wireSessionId(owner: SessionOwner | null | undefined, sessionId: string, baseHome?: string): string {
  return owner ? new RekeyLedger(baseHome).wireId(owner, sessionId) : sessionId
}
