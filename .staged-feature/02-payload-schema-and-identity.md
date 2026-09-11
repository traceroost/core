# 02 — Payload schema and identity

**Phase 2 — data shipping.** The contract both repos agree on.

**Goal:** define the one thing both repos agree on — the exact bytes a client may
send — as a closed schema with no field capable of carrying source code, plus the
stable identifiers a team server needs from the first version.

**Tier:** infrastructure. Nothing user-visible; nothing gated.

**Depends on:** nothing. Blocks AL 03, AL 04, AL 08 and SA 05.

**Status:** staged, not filed.

**Related:** `.staged-issues/open-core-groundwork.md` (identified the identity gap
and is right about it — a payload with no stable installation identity forces a
schema change plus a backfill of data that is no longer yours to migrate);
`src/summarizers/summarizerTypes.ts`; `src/serviceConfig.ts`.

---

## The correction to the obvious design

The staged `team-server/02-forwarding-infra.md` proposes forwarding
`SessionSummaryCard` — "or a redacted subset of it." Reusing the normalized shape
is the right instinct and the wrong mechanism. `SessionSummaryCard` carries
`userRequest`, `timeline[].responseText`, `timeline[].toolInput`,
`editDetails[].oldString` and `editDetails[].newString`. Those are prompts,
completions and diffs. A *redacted subset* of a shape that has those fields is a
promise enforced by the sender; the moment a client is modified, misconfigured or
compromised, the field exists and the server will accept it.

The forward payload is therefore a **separate, closed type** — not a projection
of `SessionSummaryCard`, not `Omit<SessionSummaryCard, ...>`, which silently
re-admits any field added to the parent later. Every member is a number, an
enum, a hash, a SHA or a timestamp. There is no string field that accepts free
text, so there is nothing for code to travel in.

## The payload

```
SessionRollup {
  schema_version   int
  install_id       uuid          // this machine
  member_id        uuid          // assigned by the service at link time
  session_id       uuid
  agent            enum          // claude_code | copilot | codex | opencode
  models           { model_id: enum, calls: int }[]
  repo_hash        sha256
  branch_hash      sha256
  started_at       iso8601
  duration_ms      int
  turns            int
  tokens_in        int
  tokens_out       int
  cache_read       int
  cache_create     int
  cost_usd         decimal
  tool_calls       { tool: enum, count: int }[]
  errors           int
  file_hashes      sha256[]      // derived key, see below
  repo_key_fp      sha256        // fingerprint, for mismatch detection
  one_shot         { files_considered: int, one_shot_files: int, total_edits: int }
  loop_signals     { type: enum, severity: enum }[]
  outcome          enum          // productive | reverted | abandoned | ambiguous
}

CommitRecord {
  schema_version   int
  install_id       uuid
  member_id        uuid
  repo_hash        sha256
  commit_hash      sha256        // the dedup key across members
  authored_at      iso8601
  lines_added      int
  lines_removed    int
  ai_lines         int
  attribution      enum          // certain | probable | unknown
  session_ids      uuid[]
}

TurnoverSample {
  schema_version   int
  install_id       uuid
  repo_hash        sha256
  commit_hash      sha256
  window_days      enum          // 30 | 90
  ai_lines_authored   int
  ai_lines_surviving  int
  measured_at      iso8601
}
```

`InstructionFileState`, `FileFootprint` and `SuggestionEvent` extend this schema
in AL 08. They are listed there rather than here because nothing in phases 1–4
sends them, but they are designed against these same rules and add no new field
shape: booleans, counts, enums, hashes and timestamps only.

`model_id` and `tool` are **enums, not free strings** — a client sending an
unknown model sends `other`, and the enum is extended by a schema release. A
free-text model name is a free-text field, and a free-text field is the whole
problem.

## The derived repository key — no salt is stored or distributed

Hashes must match across everyone in a team, or nothing groups. The obvious
designs both make the shared secret something the service stores and hands out,
and both are wrong: storing it lets the service dictionary-attack common paths,
and encrypting it under a key the service does not hold creates a distribution
problem with no good answer — the lead must be online when someone links, or a
passphrase ends up in a Slack thread.

**The key is derived, not distributed.** Every clone of a repository contains the
same root commit SHA — content-addressed, byte-identical on every machine, and
never transmitted, because a 30- or 90-day cohort never contains a commit from
the repository's first day.

```
root        = git rev-list --max-parents=0 HEAD   (smallest, if several)
repo_key    = HKDF(ikm = root, salt = org_id, info = "agentlens/v1")

repo_hash   = HMAC(repo_key, "repo")
branch_hash = HMAC(repo_key, "branch:" + branch)
file_hash   = HMAC(repo_key, <repo-relative posix path>)
commit_hash = HMAC(repo_key, <commit sha>)
repo_key_fp = HMAC(repo_key, "fingerprint")
```

Mixing in `org_id` — known to the service, useless without the other half —
means two orgs working on the same repository produce different hashes, so
nothing correlates across customers.

What this buys, in order of importance:

- **There is no key to store, leak, subpoena or rotate.** The service holds
  nothing, because nothing exists anywhere except on machines that already have
  the code. A database dump is inert.
- **No distribution, so no distribution failures.** A developer links at 11pm,
  derives the key from their own clone, and matches everyone else. No lead
  online, no wrapping, no recovery flow for a new laptop.
- **Checkable in ten seconds** — the derivation is a few lines in this
  repository, and a sceptic can read that the input never leaves.
- **Commit SHAs go over the wire hashed.** Nothing server-side needs the real
  value: dedup and cohort keys work identically on the hash, and the client
  resolves them locally for the hand-off. A raw SHA identifies the exact commit,
  diff and filenames of a public repository, so this closes a leak that would
  otherwise have made path hashing beside the point.

Paths are hashed repo-relative and POSIX-separated, so two developers with
different checkout locations produce the same hash.

### The three failure modes, all small and all honest

- **Shallow clones** (`--depth 1`, most CI) have no root commit. Detect it, say
  so, and report without repository grouping rather than emitting hashes that
  silently match nothing.
- **Rewritten history** changes the root SHA and therefore every hash for that
  repository. `repo_key_fp` travels on every record so the service can flag a
  mismatch between members as a warning instead of quietly showing two ghost
  copies of the same file.
- **Public repositories** have a public root SHA, so their hashes are derivable
  by anyone who identifies the repository. Public repository filenames are not
  secret either, so this is a boundary rather than a hole — state it plainly in
  `alsaas/docs/decisions/0003-what-we-can-and-cannot-see.md` rather than letting
  someone find it.

## Identity

- `install_id` — generated at first run, persisted in `~/.agentlens/config.json`
  beside the auth token. `ensureAuthToken` in `src/serviceConfig.ts` already
  establishes this pattern; this is a few lines, not a subsystem.
- `member_id` — assigned by the service at link time, not chosen locally. A
  client cannot claim to be someone else.
- Both present from schema version 1, even before anything reads them.

An operator-settable free-text member label is **not** carried. The service
already holds the member's email from the invite; a second, client-controlled
label is a free-text field on the wire for no gain.

## Privacy invariants

- No field accepts free text. Adding one is a schema change requiring a written
  decision, not a routine PR.
- No field carries a filename, path segment, repository name, branch name,
  commit message, or a raw commit SHA.
- The repository key is never transmitted, logged or written to disk. It is
  derived on demand from the clone and held only for the duration of a build.
- Anything added later that cannot be expressed as a number, enum, hash, SHA or
  timestamp does not belong in this schema.

---

## Steps

1. `src/forward/schema.ts` — the three types above, hand-written, not derived
   from `SessionSummaryCard`. A comment at the top stating why.
2. Emit a JSON Schema from it at build time to `schema/rollup.v1.json`, committed.
   This file is the artifact `alsaas` validates against; publish it at a stable
   URL alongside the docs.
3. `src/forward/repoKey.ts` — root-commit lookup, HKDF derivation, the HMAC
   helpers, the repo-relative normalization above, and the shallow-clone guard.
4. `install_id` in `src/serviceConfig.ts`, alongside `ensureAuthToken`.
5. A test that fails if any property in the JSON Schema has `"type": "string"`
   without a `pattern` or `enum` constraint. This is the mechanical guard that
   keeps the invariant true as the schema grows.

## Acceptance

- `schema/rollup.v1.json` exists, is committed, and every string property is
  constrained by `pattern` or `enum`.
- The guard test fails when an unconstrained string property is introduced.
- Two clones of the same repository at different paths produce identical
  `repo_hash` and `file_hashes` without exchanging anything.
- Nothing in `src/forward/` imports `SessionSummaryCard`.

## Notes

Schema versioning is `schema_version` on every record, not a URL path. The
service accepts version N and N−1 during a rollout; clients are not upgraded in
lockstep and a laptop that has been asleep for a month will send an old version.
