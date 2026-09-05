# 09 — Free/paid boundary and hand-off

**Phase 6 — commercial close-out.**

**Goal:** make the line between free and Pro visible, structural and
unresentable in the client — and give the hosted service a way to send a lead
back to their own machine for anything involving code.

**Tier:** both, by definition. This plan *is* the boundary.

**Depends on:** AL 07, AL 08, SA 15.

**Status:** staged, not filed.

**Related:** `claude/agentlens-pro-strategy.md` §5 ("The free/paid boundary");
`.staged-issues/team-server/01-monetization-strategy.md` (the conservatism
argument there is right and survives the change of model).

---

## The boundary, in one line

**Free is my machine. Paid is everyone's.**

- **Free, complete and ungimped:** every session, every trace, every analytic,
  the Advisor, loop detection, unlimited retention, and the turnover report for
  the developer's own commits and repositories.
- **Paid:** cross-developer aggregation — the team view, team cohorts,
  per-repository rollups across people, the weekly digest.

This works because it is structural rather than administrative. A local install
*genuinely cannot* see other people's machines. There is nothing to resent, no
flag to patch out, and no fork that recovers the paid capability, because forking
the client does not produce a multi-tenant service. It also maps cleanly onto the
difference between the user (a developer) and the buyer (their lead).

## What that forbids in this repo

Written down because each of these is a reasonable-seeming decision that would
quietly break the model:

- **No feature is removed from free to create a reason to upgrade.** Every plan
  in this folder that produces local value ships free. AL 05, AL 06 and AL 07 are
  the differentiator and they are free on purpose.
- **No quotas.** Not on sessions, retention, repositories or history. A usage
  quota taxes the behaviour that creates value and habit, so it punishes the most
  engaged users — the ones nearest to buying — and generates a support ticket at
  the moment of interruption.
- **No trial.** The free tier is the discovery mechanism; a trial converts at one
  fixed moment, a free tier converts whenever the need finally arrives.
- **No free self-hostable *team* server.** A multi-user server the customer runs
  sits on the paid side of this line and cannibalises Pro outright. Free
  self-hosting means the single-developer local tool. This is the point where
  this folder departs from `.staged-issues/team-server/`, and it should be stated
  on the pricing page rather than left to be discovered in an issue thread.
- **One Pro reference per surface, maximum.** See AL 07.

## The hand-off

The hosted service holds counts, not code. So "turnover is 31%, show me an
example" cannot be answered there — but it *can* be answered here, on a machine
that has the repository. The capability survives; only its location changes.

That has to be an explicit affordance, or its absence reads as a missing feature
on first use:

```
agentlens cohort --repo <hash|name> --merged 2026-07
agentlens cohort --repo <hash|name> --merged 2026-07 --window 90
```

Opens the Outcomes tab filtered to that cohort, listing the commits, the files
and the sessions behind the number, resolved to real names locally. Invoked from
a copyable command and from an `agentlens://` deep link the team view offers.

Repository hashes resolve locally because the client can re-derive the key from
  the clone (AL 02). The
service can hand over a hash and never learn a name.

## Privacy invariants

- The deep link carries only a hash, a date and a window. It never carries a
  path, a filename or a repository name.
- A deep link from an untrusted source cannot cause a network call, a write, or
  anything other than a local filter — treat its parameters as untrusted input
  and validate their shape before use.
- The hand-off resolves hashes only for repositories on this machine and shows
  "not a repository on this machine" for anything else. It is not an oracle for
  testing hashes against.

---

## Steps

1. `standalone/cli.ts` — `agentlens cohort` with the flags above.
2. URI handler registration for `agentlens://cohort?...` in the extension, with
   strict parameter validation.
3. Local hash→path resolution from the derived repository key.
4. A `docs/pricing-boundary.md` stating the boundary, the four refusals above and
   the free-self-hosting scope, in language that can be lifted onto the pricing
   page verbatim.
5. Audit pass: grep the client for anything that disables, blurs, counts down or
   upsells, and remove it.

## Acceptance

- With no team linked, every local feature works and exactly one line in the
  product mentions Pro.
- An `agentlens://cohort` link for a repository this machine does not have shows
  a plain message and makes no request.
- `docs/pricing-boundary.md` and the published pricing page agree word for word.

## Notes

The acid test for the whole positioning: AgentLens should be installable
*alongside* a general LLM-observability tool, not instead of one. If a team can
run one for debugging and AgentLens for outcome tracking without feeling they are
paying twice, this boundary is drawn correctly.
