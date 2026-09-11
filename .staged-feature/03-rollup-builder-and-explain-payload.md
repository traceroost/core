# 03 — Rollup builder and `--explain-payload`

**Phase 2 — data shipping.**

**Goal:** turn local session and cohort data into the exact records of AL 02, and
make what would be sent trivially inspectable before anything is sent.

**Tier:** infrastructure for Pro. Builds records; does not transmit (AL 04 does).
`--explain-payload` works on a free install with no team.

**Depends on:** AL 02. Blocks AL 04.

**Status:** staged, not filed.

**Related:** `src/sessionRepository.ts`; `src/oneShotRate.ts`; `src/loopDetector.ts`;
`standalone/cli.ts`.

---

## The builder

`SessionRollup` from a `SessionSummaryCard`, dropping everything that is not in
the schema and hashing every path. The mapping is mechanical and the code should
read that way — a flat function, no inheritance, no spread of the source object.
Spreading `SessionSummaryCard` and deleting keys is the failure mode this whole
design exists to prevent; the builder names every output field explicitly.

`CommitRecord` and `TurnoverSample` come straight from AL 05 and AL 06.

Validate every built record against `schema/rollup.v1.json` **in the client,
before queueing**, in debug builds and in tests. The server validates too (SA 05);
validating in both places means a schema mistake is caught by whoever introduced
it rather than by a customer.

## `--explain-payload`

```
$ agentlens --explain-payload --last
```

Prints the exact JSON that would be transmitted for the most recent real session
— not a synthetic example, not a documentation sample. Options: `--session <id>`,
`--since <date>`, `--all` for everything currently queued.

This is the single most persuasive artifact available and it costs almost
nothing. The claim is only worth what a sceptical developer can verify in ten
seconds without trusting anyone, and this is that verification. It is therefore:

- Available on a free install with no team linked.
- Documented on the privacy page with an explicit invitation to run a network
  capture and confirm nothing else goes over the wire.
- Covered by a test that fails if the printed JSON and the queued JSON diverge —
  an `--explain-payload` that prints something other than what is sent is worse
  than not having it.

`--dry-run` is the same output for a live session without queueing it.

## Privacy invariants

- The builder names every output field. No spread, no `Omit<>`, no
  `JSON.parse(JSON.stringify(session))`.
- Hashing happens in the builder, not at the transport layer. A record never
  exists in memory in unhashed form beyond the single call that hashes it.
- `--explain-payload` output is the queued bytes, byte for byte.
- The repository key is never printed, including under `--explain-payload` and
  including in verbose or debug modes.

---

## Steps

1. `src/forward/buildSessionRollup.ts` — explicit field-by-field mapping.
2. `src/forward/buildCommitRecords.ts`, `src/forward/buildTurnoverSamples.ts`.
3. `src/forward/validate.ts` — JSON Schema validation against the committed
   `schema/rollup.v1.json`.
4. `standalone/cli.ts` — `--explain-payload`, `--dry-run` and their flags.
5. Tests:
   - Every field of `SessionSummaryCard` that could hold text (`userRequest`,
     `responseText`, `toolInput`, `oldString`, `newString`, `fullResult`,
     `thinking`) is set to a recognisable marker string; the built rollup is
     serialised and asserted not to contain the marker. This test is the
     invariant, and it should be named so nobody deletes it casually.
   - A file path with spaces, unicode and a leading `./` hashes identically to
     its normalized form.
   - `--explain-payload` output equals the queued record.

## Acceptance

- The marker test fails if anyone adds a text field to the built rollup.
- `--explain-payload` runs on an install with no account and prints real data.
- A network capture during a forward shows only what `--explain-payload` printed.

## Notes

Print the payload with stable key ordering. A developer diffing two runs to
convince themselves nothing varies should see a clean diff.
