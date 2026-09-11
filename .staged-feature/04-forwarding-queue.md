# 04 — Forwarding queue

**Phase 2 — data shipping.** The last client piece before data arrives.

**Goal:** get rollups to the service without ever being in a developer's way.

**Tier:** Pro. Inert on a free install.

**Depends on:** AL 01, AL 03, SA 05.

**Status:** staged, not filed.

**Related:** `ARCHITECTURE.md` §13 (background service design — same reasoning);
`.staged-issues/team-server/02-forwarding-infra.md` (the disk-backed-queue
argument there is right and carries over).

---

## The constraint that shapes this

**The cloud is a read-only mirror.** If the service is down, no developer is
blocked; a lead's dashboard is stale for an hour. That converts every outage from
an incident into an inconvenience, which is what makes a one-person on-call
rotation honest rather than aspirational.

So there is no synchronous path from a developer's keystroke to the service. Not
a fast one, not a short-timeout one — none. Rollups are built after a session
closes, appended to a disk-backed queue, and drained on a timer.

## Queue

- Disk-backed, in `~/.agentlens/`, surviving restarts and sleep. Agents do not
  retry failed OTLP exports and the same is true one hop further upstream: a
  laptop that is offline or asleep must not silently lose data.
- Idempotent on `session_id` / `commit_sha` / (`commit_sha`, `window_days`), so
  a retry after an ambiguous failure is free and the server can deduplicate.
- Exponential backoff with jitter; a hard cap on queue size with oldest-first
  eviction, so an install that never reconnects does not grow without bound.
- Batched — many small records per request rather than one request per session.

## Failure behaviour

Every failure mode degrades to "stale dashboard", never to "broken client":

| Failure | Behaviour |
|---|---|
| Service unreachable | Queue, back off, retry. No UI change. |
| 401 / token expired | Refresh once; on failure, surface a single, dismissible notice and keep queueing. |
| 403 / membership revoked | Stop forwarding, clear the credential, tell the developer once. |
| 400 / schema rejected | Drop the record, log locally with the validation error, do not retry. Retrying a record the server will never accept is a loop. |
| 429 | Back off per `Retry-After`. |
| Disk full | Stop queueing, keep working. Nothing local depends on the queue. |

## Privacy invariants

- The queue on disk holds built rollups only — records that have already passed
  through AL 03's hashing. There is no intermediate on-disk form containing paths.
- No request is made when no team is linked, including health checks and version
  pings.
- Queue contents are readable by `--explain-payload --all`, so a developer can
  see exactly what is pending.
- The queue file is written with user-only permissions.

---

## Steps

1. `src/forward/queue.ts` — append-only file with a compaction pass, or SQLite if
   the existing DB is a better fit; do not add a dependency for this.
2. `src/forward/sender.ts` — batching, backoff, the failure table above.
3. Wire into the session-close path in `src/sessionRepository.ts` and into the
   cohort recompute in AL 06.
4. Drain on a timer in both the extension host and `standalone/server.ts`.
5. `agentlens team status` reports queue depth and last successful send.
6. Tests: each row of the failure table; restart with a non-empty queue;
   duplicate delivery is a server-side no-op (paired with SA 05's test).

## Acceptance

- With the service returning 500 for an hour, a full working session is
  unaffected and every rollup arrives afterwards.
- Killing the process mid-drain loses nothing and duplicates nothing observable.
- No forwarding thread starts on an unlinked install.

## Notes

Send on a timer, not on session close, even though the trigger is session close.
Closing a session is a moment the developer is watching; a network call attached
to it is a network call they will notice when it is slow.
