# 0002 — Model/agent cost-per-outcome comparator is cloud-only, not a local/free feature

**Status:** accepted · 2026-09-19

## Context

`.staged-issues/model-cost-per-outcome-comparator.md` proposed answering "for this kind of task,
model X costs less than model Y for the same outcome" by bucketing sessions on **same repo, same
rough task-complexity tier (`inferTaskComplexity`, `loopDetector.ts`), same outcome
(`classifySessionOutcome`)**, then comparing cost across models within a bucket — explicitly
scoped as the free/local starting point, with cross-developer cloud aggregation as a later
follow-on once the local framing proved useful.

The doc's own Step 1, before building anything: **confirm this bucketing produces a non-noisy
signal at realistic session volumes** — the same "profile before building" discipline
`.staged-issues/scalability.md` used, explicitly warning that if buckets are too sparse per user,
"this is cloud-only from day one, not a free-tier feature with a stub."

## The check

Queried this machine's own real local TraceRoost history (`~/Library/Application Support/Code/
User/globalStorage/agentlens.agentlens-dashboard/traceroost.db`, 60 sessions accumulated before
the rebrand — the fuller of the two local DBs on this machine) directly, rather than building a
synthetic stress test first, since real usage was already sitting right there:

```
workspace                              model              count
/Users/rogerreed/git/agentlens         claude-sonnet-5    10
/Users/rogerreed/git/agentlens         claude              1
/Users/rogerreed/git/alsaas            claude-sonnet-5     9
/Users/rogerreed/traceroost/cloud      claude-sonnet-5    12
/Users/rogerreed/traceroost/cloud      claude-fable-5.1    2
/Users/rogerreed/traceroost/cloud      auto                2
/Users/rogerreed/traceroost/cloud/infra claude-sonnet-5    2
/Users/rogerreed/traceroost/core       claude-sonnet-5    20
/Users/rogerreed/traceroost/core       claude-fable-5.1    1
/Users/rogerreed/traceroost/core       auto                1
```

Two findings, both against the comparator's premise:

1. **Zero within-agent model diversity.** Every `claude_code`-source session in every repo uses
   `claude-sonnet-5`, except one legacy `claude` alias row. The only "other models" present
   (`claude-fable-5.1`, `auto`) belong to `copilot`-source sessions — a different agent entirely,
   not a same-agent model swap. The comparator wants to isolate *model* choice; comparing across
   agent boundaries confounds it with tool/workflow choice instead.
2. **Where a second data point exists at all, it's a 10–20:1 imbalance** (10 sonnet-5 vs. 1
   `claude` in `agentlens`; 20 vs. 1 vs. 1 in `core`) — nowhere near enough same-bucket samples on
   either side to say anything about cost-per-outcome without it being noise dressed as a finding.

This matches the mechanism the original doc worried about, not a data-collection accident: a
developer picks one agent/model and sticks with it for a repo (or for months), rather than
A/B-ing models turn-by-turn on comparable tasks. One person's local history structurally will not
contain the "same task, different model" pairs this feature needs, no matter how much history
accumulates — more sessions on the dominant model doesn't manufacture samples on the others.

## Decision

**Do not build the local/free-tier version** (`compareCostPerOutcome`, a UI surface in Advisor,
Steps 2–3 of the staged issue). The premise it was built on — that a single developer's repo
history has enough intra-repo, intra-agent model diversity to bucket and compare — does not hold
against this machine's real data, and the mechanism that produced this result (one
person, one model per repo, most of the time) is not specific to this machine.

**The cloud follow-on (Step 4) is the only viable path**, from day one, not as a later
enhancement: cross-developer aggregation is exactly what supplies the model diversity a single
local history structurally lacks — different team members already make different model choices
on the same repo, which is the "same task, different model" pair this feature needs. That is a
new `cloud` feature (extending `cloud/src/lib/rollups/advisor.ts`'s `retryPasses`-style
aggregation with the same cost join, cross-developer), not a `core` change, and carries its own
design work (minimum sample size per bucket, UI placement, the same "comparable, not identical,
work" caveat the original doc required) — scoped separately, not assumed here.

## Consequences

- `.staged-issues/model-cost-per-outcome-comparator.md` is closed — its Step 1 question is
  answered, and its Steps 2–3 (the local pure function and Advisor surface) are not built.
- No new code ships in `core` from this decision. Nothing regresses; `retryPasses` (cloud) already
  answers agent reliability per repo and is unaffected.
- If cross-developer cost-per-outcome is wanted, it starts as a new `cloud` design — the
  minimum viable version is "same repo, same complexity tier, same outcome, joined with cost,
  aggregated across a team's members," which is `retryPasses`'s existing shape plus a cost column,
  not a new mechanism.
- This finding is specific to the *local* bucketing premise; it says nothing about whether
  cross-developer aggregation would itself be noisy — that still needs its own check once a design
  exists, the same discipline this record used.
