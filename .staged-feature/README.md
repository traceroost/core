# .staged-feature

Ordered backlog for the **AgentLens Pro** work in this repo: the client half of a
two-repo build. The other half is `alsaas/.staged-feature/` (the hosted service).

Work the phases in order. Inside a phase, work the numbers in order.

The product decision these implement is `claude/agentlens-pro-strategy.md` in the
AgentLens project; the screen-level definition is `claude/pro-functional-spec.md`;
the screens are the "AgentLens Pro Screens" canvas.

## The two rules every plan below is written against

**1. Privacy is a property, not a promise.** The server must have nowhere to put
source code, not merely a policy against keeping it. Every plan carries a
*Privacy invariants* section naming what that step must not make possible. A step
that would give the payload a free-text field, or give the service a way to ask
for one, is wrong even if nothing currently exploits it.

**2. The free/paid line is single-player vs. multiplayer.** Everything about
*my machine, my commits, my repositories* is free, complete and ungimped. Paid is
*everyone's*: cross-developer aggregation, which a local install genuinely cannot
do. Nothing local is ever gated, degraded, or nagged behind Pro. Every plan
carries a **Tier** line saying which side it is on.

## The phases

Nothing in a later phase is worth starting before the phase above it works end to
end. `AL` = this repo, `SA` = `alsaas`.

### Phase 1 — Identity and access

Who a person is, which team they belong to, what their role lets them see, and
how a machine joins. No telemetry moves yet. Ends when a developer can link a
laptop and a lead can see them on a roster.

| Repo | Plan |
|---|---|
| SA | 01 — Org, membership and roles |
| SA | 02 — Auth and onboarding |
| SA | 03 — PKCE authorization server |
| AL | [01 — Pro panel and team link](01-pro-panel-and-team-link.md) |
| SA | 04 — Invites, roster and roles |

### Phase 2 — Data shipping

Rollups leave a machine, survive the network, and land in a table. Ends when
three linked machines are reporting and the rows can be counted. **No product
screens in this phase** — the success criterion is a row count, not a dashboard.

| Repo | Plan |
|---|---|
| AL | [02 — Payload schema and identity](02-payload-schema-and-identity.md) |
| AL | [03 — Rollup builder and `--explain-payload`](03-rollup-builder-and-explain-payload.md) |
| SA | 05 — Ingest endpoint |
| AL | [04 — Forwarding queue](04-forwarding-queue.md) |
| SA | 06 — Storage and commit dedup |

### Phase 3 — First team view

The smallest thing worth paying for: volume, cost, agent mix and one-shot rate
across people, plus each member's own numbers. Ships to a real customer.

| Repo | Plan |
|---|---|
| SA | 07 — First team view |

### Phase 4 — The outcome metric

Attribution, cohorts, turnover. **Free-track:** nothing in phases 1–3 depends on
any of it, so it can start at any time — and it probably should. AL 07 is the
free tier's activation event and therefore the entire distribution channel; a
free report that lands is what produces the installs the paid product converts
from. Ordering it after the SaaS spine is a sequencing choice, not a dependency.

| Repo | Plan |
|---|---|
| AL | [05 — AI authorship attribution](05-ai-authorship-attribution.md) |
| AL | [06 — Cohort turnover engine](06-cohort-turnover-engine.md) |
| AL | [07 — Local turnover report (free)](07-local-turnover-report-free.md) |
| SA | 08 — Aggregation and cohorts |
| SA | 09 — Turnover views |

### Phase 5 — The action layer

Where a number becomes a change: instruction-file coverage, pooled suggestions,
recurring tasks, and the measured before/after. This is what the product is
actually for.

| Repo | Plan |
|---|---|
| AL | [08 — Instruction telemetry and the apply loop](08-instruction-telemetry-and-apply-loop.md) |
| SA | 10 — Instructions and effectiveness |
| SA | 11 — Repeat work and recurring tasks |
| SA | 12 — Action detail and apply |

### Phase 6 — Retention and commercial close-out

| Repo | Plan |
|---|---|
| SA | 13 — Weekly digest |
| SA | 14 — Activity and waste |
| SA | 15 — Plan, seats, retention and deletion |
| AL | [09 — Free/paid boundary and hand-off](09-free-paid-boundary-and-handoff.md) |

## Where the contract lives

The wire schema is defined **here**, in the open-source client, and published as
a versioned artifact the service consumes — not the other way round. The claim
being made is *this client cannot send your code*, and that claim is only worth
what a sceptical developer can read in the repository they already trust. A
schema owned by the closed service and mirrored here would invert that.

`alsaas` validates every ingest against the same published document. See
[02](02-payload-schema-and-identity.md).

## What must never regress

- AgentLens works completely with no account, no network, and no Pro. The cloud
  is a read-only mirror; if it is unreachable, a rollup queues and nothing else
  changes.
- No prompt, completion, diff, file content, filename or repository name leaves
  the machine, on any tier, ever. There is no opt-in that changes this.
- Joining a team is an explicit act; leaving is equally explicit and equally easy.
- `--explain-payload` prints the real bytes for a real session, always.

## Relationship to `.staged-issues/team-server/`

That folder plans a different model: a self-hosted team server unlocked by a
license key, at $15–25/developer/month, with a hosted tier listed as optional.
It stays where it is as a live alternative.

**This folder is the plan being built.** Hosted SaaS, flat team pricing, rollups
only, and free self-hosting scoped to the single-developer local tool. Where the
two describe the same ground — the forward payload, the disk-backed queue, the
free/paid line — the plans here are the ones to implement, and they say so
individually. Nothing in this folder depends on that one.
