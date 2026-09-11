# The AgentLens Pro wire schema

This is the **complete** description of what a linked machine can send to the AgentLens Pro
service. It is defined here, in the open-source client, and the hosted service validates every
request against the identical document.

- **Machine-readable:** [`schema/rollup.v1.json`](../schema/rollup.v1.json) — JSON Schema
  (draft-07), committed to this repository and shipped in the npm package and the VSIX.
- **TypeScript form:** [`src/cloud/forward/schema.ts`](../src/cloud/forward/schema.ts) — the same contract as
  hand-written types, with the enum mappings the builder uses.
- **Published copy:** the service serves the byte-identical file at
  `https://app.agentlens.dev/api/ingest/schema`.

## The claim, and how to check it

> This client cannot send your source code.

The schema has **no free-text field**. Every string in it is a hash (`[a-f0-9]{64}`), a UUID, an
enum, a bounded-charset identifier (a model name is `^[A-Za-z0-9._:@/-]{1,80}$` — no spaces, no
prose), or an ISO 8601 timestamp. A test (`src/test/forward/schema.test.ts`) walks the schema on
every CI run and fails if any string is left unconstrained or any object is left open.

To verify for yourself:

1. Run `agentlens --explain-payload --last` — it prints the exact bytes that would be sent for
   your most recent real session.
2. Run a packet capture (`mitmproxy`, Charles, `tcpdump`) over a full working session.
3. Confirm the only request to `app.agentlens.dev` is a `POST /api/ingest` whose body matches
   what `--explain-payload` printed — and that an **unlinked** install makes no request at all.

## What is not in the payload

`install_id` and `member_id` are **not** in the request body. The service derives them from the
bearer token, so a client cannot claim to be another member. The repository key is never
transmitted, logged, or written to disk — it is derived on demand from your own clone
([`src/cloud/forward/repoKey.ts`](../src/cloud/forward/repoKey.ts)) and held only for the duration of a
build.

Grounding: `alsaas/docs/decisions/0003-what-we-can-and-cannot-see.md`.

## Versioning

Every record carries `schema_version` (currently `"1"`). The service accepts version *N* and
*N−1* during a rollout — a laptop that has been asleep for a month sends an old version and it
is still taken. Version is a field, never a URL path.
