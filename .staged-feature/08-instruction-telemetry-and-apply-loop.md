# 08 — Instruction telemetry and the apply loop

**Phase 5 — the action layer.** The client half of the screens that turn a
number into a change.

**Goal:** report enough about a repository's agent instruction files, and about
changes applied to them, for the service to pool evidence across a team — and
close the loop by drafting and applying the change locally, where the paths are.

**Tier:** the local Advisor stays free and unchanged. What is Pro is the pooled
evidence and the team-wide measurement, which a single install cannot produce.

**Depends on:** AL 02, AL 03, AL 04.

**Status:** staged, not filed.

**Related:** `src/instructionAdvisor.ts` (`getHotFileSuggestions`,
`getFrontLoadedDiscoverySuggestions`, `getLoopPreventionSuggestions`,
`getScopeSuggestions`, `getToolDisciplineSuggestions`);
`src/instructionEffectiveness.ts` (`computeBaseline`, `computePostMetrics`,
`computeEffectiveness`, `computeImpactSummary`); `src/instructionFiles.ts`;
`src/database/schema.ts` (`instruction_applied`, `instruction_dismissed`).

---

## The split that makes this work

The service can know that *some* file is read in 62% of sessions by four of six
developers. It cannot know which file, because it holds a salted hash. The
client knows which file and can write the sentence, but cannot know what the
other five developers' sessions did.

So: **the cloud finds the pattern, the machine writes the text.** Neither half
can do the other's job, and the product should say so on the page rather than
hiding it. It is also why this is genuinely Pro — `getHotFileSuggestions` already
fires at a 40% threshold over *one person's* sessions; pooling raises the
evidence from "you read this a lot" to "four of you do, and none of your
instruction files mention it," which no local install can reach.

## What gets reported

Three additions to AL 02's schema, all counts, enums, hashes and booleans:

```
InstructionFileState {
  repo_hash        sha256
  present          bool
  kind             enum        // claude_md | agents_md | copilot_instructions | other
  path_hash        sha256
  content_hash     sha256      // changed / unchanged, nothing more
  line_count       int
  last_modified    iso8601
}

FileFootprint {                // one per hot file hash, per repo, per window
  repo_hash        sha256
  file_hash        sha256
  sessions_read    int
  sessions_total   int
  early_reads      int         // read within the first three turns
  token_size       int         // the file's own size, for the rediscovery cost
  covered_by_instructions bool // computed locally, the substring check that
}                              // getHotFileSuggestions already performs

SuggestionEvent {
  repo_hash        sha256
  suggestion_id    sha256      // hash of the existing SuggestionCard.id
  category         enum        // context | behavior | prompting
  priority         enum        // high | medium | low
  target_agents    enum[]
  action           enum        // surfaced | applied | dismissed | reverted
  at               iso8601
  baseline         { cost_avg, turns_avg, error_rate, loop_rate, insufficient }
}
```

`covered_by_instructions` is the one that carries the most product value for the
least data: the client already computes
`existingInstructionText.toLowerCase().includes(basename.toLowerCase())` inside
`getHotFileSuggestions`. Sending the boolean lets the service rank "read
constantly and named nowhere" across a whole team without ever seeing either
string.

`token_size` is what makes the arithmetic on the action screen real rather than
a guess — reads × file size × price is a floor on the rediscovery cost that
anyone can check.

## The apply loop

```
agentlens advise --apply <suggestion_id>
```

Resolves the hash against the locally-derived repository key, regenerates the suggestion with real
paths through the existing Advisor code, shows the drafted line for editing,
appends it to the instruction file on confirmation, and writes the
`instruction_applied` row that `computeBaseline` already depends on. Then emits
a `SuggestionEvent` with `action: applied` and the baseline snapshot.

Everything after that is measurement the client already does:
`computePostMetrics` and `computeEffectiveness` produce cost, turns and error
deltas with a confidence level from post-change session count. Those results
forward as further events, and the service averages them across members.

A change that made things worse reports as worse, and `action: reverted` is a
first-class event. A tool that only ever reports improvement is not measuring
anything.

## Privacy invariants

- `suggestedText`, `evidence` and `title` from `SuggestionCard` **never leave the
  machine**. Only `suggestion_id` (hashed), category, priority, target agents and
  the numeric baseline.
- Instruction-file *content* never leaves. `content_hash` answers "did this
  change" and nothing else; `line_count` is a number.
- `covered_by_instructions` is computed locally. The service receives the answer,
  never the inputs.
- The hand-off resolves hashes only for repositories this machine has cloned,
  and shows
  "not a repository on this machine" for anything else — it is not an oracle for
  testing hashes against.

---

## Steps

1. `src/forward/buildInstructionState.ts` — read the repo's instruction file via
   `src/instructionFiles.ts`, emit `InstructionFileState`.
2. `src/forward/buildFileFootprints.ts` — the hot-file frequency map
   `getHotFileSuggestions` already builds, plus `token_size` and the coverage
   boolean.
3. `src/forward/buildSuggestionEvents.ts` — from `instruction_applied` and
   `instruction_dismissed`, plus a `surfaced` event when the Advisor renders one.
4. `standalone/cli.ts` — `advise --apply`, `advise --list`, and the
   `agentlens cluster --repo … --id …` hand-off from the team view.
5. URI handler for `agentlens://advise?id=…` with strict parameter validation.
6. Extend the marker test from AL 03: set `suggestedText`, `evidence` and `title`
   to recognisable strings and assert none appears in any built record.

## Acceptance

- The marker test fails if suggestion prose ever reaches the wire.
- `advise --apply` on a repository produces the same line the local Advisor
  would, writes the instruction file, and captures a baseline.
- A reverted change reports `reverted` and stops contributing to the team
  average.
- A deep link for an unknown repository makes no request and shows a plain
  message.

## Notes

Cluster naming is the same shape of problem: a runbook candidate is found from
file-hash sets and tool-call counts, but what the job *is* lives in the prompts.
So a cluster is unnamed until a member types a name in the app, or until this
hand-off opens it locally and drafts one. Ship the hand-off; do not try to derive
a name server-side.
