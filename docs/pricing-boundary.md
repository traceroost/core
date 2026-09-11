# The free / paid boundary

*This document is the source of the pricing-page copy. The published page and this file agree
word for word.*

## The boundary, in one line

**Free is my machine. Paid is everyone's.**

- **Free, complete and ungimped:** every session, every trace, every analytic, the Advisor, loop
  detection, unlimited retention, and the AI-code turnover report for your own commits and your
  own repositories.
- **Paid (AgentLens Pro):** cross-developer aggregation — the team view, team cohorts,
  per-repository rollups across people, pooled instruction suggestions, and the weekly digest.

This works because it is structural, not administrative. A local install *genuinely cannot* see
other people's machines. There is nothing to resent, no flag to patch out, and no fork that
recovers the paid capability — forking the client does not produce a multi-tenant service. It
also maps cleanly onto the difference between the user (a developer) and the buyer (their lead).

## What the free tier will never do

Each of these is a reasonable-seeming decision that would quietly break the model.

- **No feature is removed from free to create a reason to upgrade.** AI authorship attribution,
  the cohort turnover engine, and the local turnover report are the differentiator, and they are
  free on purpose — the free report is what produces the installs the paid product converts
  from.
- **No quotas.** Not on sessions, retention, repositories or history. A usage quota taxes the
  behaviour that creates value and habit, punishing the most engaged users — the ones nearest to
  buying.
- **No trial.** The free tier is the discovery mechanism; a trial converts at one fixed moment,
  a free tier converts whenever the need finally arrives.
- **No free self-hostable *team* server.** A multi-user server a customer runs sits on the paid
  side of this line and cannibalises Pro outright. Free self-hosting means the single-developer
  local tool.
- **One Pro reference per surface, maximum.** The Outcomes tab carries exactly one line, in the
  cohort-view footer.

## Privacy, on every tier

- No prompt, completion, diff, file content, filename, path, repository name, branch name,
  commit message or raw commit SHA ever leaves the machine. There is no opt-in that changes
  this. The wire schema ([`schema/rollup.v1.json`](../schema/rollup.v1.json)) has no free-text
  field.
- An unlinked install makes no request to any AgentLens service — no version ping, no "do you
  have a team" check.
- `agentlens --explain-payload` prints the exact bytes for a real session, always. Joining a
  team is an explicit act; leaving is one command and takes effect immediately, even offline.

## The hand-off

The hosted service holds counts, not code, so "turnover is 31%, show me an example" is answered
on your machine, not theirs:

```
agentlens cohort --repo <hash|name> --merged 2026-07
agentlens cohort --repo <hash|name> --merged 2026-07 --window 90
```

Also reachable from an `agentlens://cohort?repo=<hash>&merged=<YYYY-MM>&window=<30|90>` deep link
the team view offers. Repository hashes resolve locally because the client re-derives the key
from your clone; the service hands over a hash and never learns a name. A deep link for a
repository this machine does not have shows a plain message and makes no request.

## The acid test

AgentLens should be installable *alongside* a general LLM-observability tool, not instead of one.
If a team can run one for debugging and AgentLens for outcome tracking without feeling they are
paying twice, this boundary is drawn correctly.
