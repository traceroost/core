# Demo toolchain

Scripts for generating realistic TraceRoost trace data without a real AI agent, a real API key, or any real/sensitive data — useful for local development, screenshots, and live demos. Every scenario plays out against a single running example (a pet store app: adoption flow, inventory, checkout, pet-image uploads) so the demo tells one coherent story across scenarios and agents instead of unrelated snippets.

All commands assume the standalone server is running:

```bash
pnpm run local
```

This starts the OTLP collector on port `4318` and the dashboard UI on port `3000`.

## Replay (synthetic data)

```bash
pnpm run demo                                    # all agents, all scenarios
pnpm run demo -- --agents codex                  # Codex only
pnpm run demo -- --scenario loop --agents claude,codex
pnpm run demo -- --speed 5                       # 5x faster than real-time
pnpm run demo -- --scenario story                # 10-trace petstore build-out (see below)
```

`demo/replay.ts` sends synthetic OTLP spans directly to the collector's `/v1/traces` endpoint — no real agent runs, no API cost is incurred.

**Flags:**

| Flag | Values | Default | Notes |
| --- | --- | --- | --- |
| `--scenario` | `normal`, `loop`, `errors`, `compaction`, `all`, `story` | `all` | `compaction` is Claude-only |
| `--agents` | comma-separated: `claude`, `codex`, `copilot` | all three | invalid names are ignored; an empty/invalid list falls back to all three |
| `--speed` | multiplier | `1` | e.g. `--speed 5` runs 5x faster |
| `--port` | port number | `4318` | must match the collector's OTLP port |

**Scenarios** (each runs once per requested agent, except `compaction`):

- `normal` — clean multi-turn task. Populates the Tokens, Files, Timeline, and Efficiency tabs.
- `loop` — the same failing command repeated several times. Triggers the Loop Breaker automation and the "Tool Call Deadlock" / "Hallucination Amplification Loop" signals.
- `errors` — a type error followed by a fix. Populates the Errors and Recommendations tabs.
- `compaction` — input tokens grow ~4x per turn (Claude only). Triggers the Context Compaction signal.
- `all` — every scenario above, in sequence.
- `story` — a fixed 10-chapter narrative building out the same petstore app from scratch: scaffold → data model → inventory service → checkout discount → image upload → search + caching → e2e tests → a Docker build stuck in a loop → a type error and its fix → a TODO sweep that triggers context compaction. Every chapter has a claude/codex/copilot variant and touches a distinct, realistic set of files (not just `cart.ts`/`discounts.ts`), so the Files tab reads like one real app taking shape. Runs **10 traces per requested agent** — unfiltered (default, all three agents) that's 30 traces; `--agents codex` narrows it to the 10 Codex-told chapters, not fewer.

### Browser demo

```bash
pnpm run demo:show -- --scenario story                 # the full 30-trace petstore build-out (10 per agent)
pnpm run demo:show -- --scenario story --agents codex   # ...just Codex's 10 chapters
pnpm run demo:show                                      # open a headed Chromium window + replay all scenarios
pnpm run demo:tour                                      # also navigate between dashboard tabs automatically
pnpm run demo:show -- --speed 4                         # flags pass through to replay
pnpm run demo:show -- --cdp                             # reuse an already-open demo browser (see below)
```

Note: for the plain (non-`story`) scenario matrix, `--agents` still *filters* rather than adds — `--agents codex` alone runs the default `all` matrix restricted to Codex, which is only 3 traces (`normal`/`loop`/`errors`; `compaction` stays Claude-only outside of `story` mode). Only `--scenario story` guarantees 10 traces per requested agent.

**`--cdp`** — by default every `demo:show`/`demo:tour` run opens a brand new Chromium window. `--cdp` attaches to a browser this script already left open instead, over the Chrome DevTools Protocol, so repeated runs reuse the same window/tab rather than piling up new ones. There's no port to hunt for: it always uses the same fixed port (`9223`, override with `--cdp-port`), so the first `--cdp` run finds nothing there yet and just launches a fresh window with that debug port open; every run after that attaches to it. Ctrl+C in `--cdp` mode leaves the browser running for next time instead of closing it. This can only attach to a browser started this way — it can't reach into an arbitrary Chrome window you already had open without a debug port exposed.

`--tour` walks: the Traces tab → expands the most recent trace and steps through its Overview / Waterfall / Flow / Tools / Files detail nav → Analytics → the Settings (gear) panel, where Alerts and Automation actually live (they aren't top-level tabs) → Advisor → Export → Import, then returns to Traces and leaves the browser open.

Requires `npx playwright install chromium` once. The browser window stays open after replay finishes; close it manually or `Ctrl+C` the terminal.

## Capturing real agent runs as fixtures

For a deterministic replay of an actual agent run (rather than synthetic data), record one with `pnpm run capture`, then replay it later:

```bash
pnpm run capture -- my-session              # start recording
pnpm run capture -- --duration 120          # auto-save after 120s
pnpm run capture:list                       # list saved fixtures
pnpm run capture -- --delete my-session     # remove a fixture

pnpm run demo -- --fixture my-session       # replay a saved fixture
```

Works with Claude Code and Codex, both of which route telemetry through the standalone server's OTLP endpoint. Copilot telemetry routes through the VS Code extension instead, so it can't be captured this way — record a mixed Claude Code / Codex run if you need fixture coverage.

**Before committing any fixture file**, run the redaction script — fixture JSON is gitignored by default specifically to prevent accidental PII exposure:

```bash
node scripts/redact-spans.js
```

## Replaying a trace export file

```bash
pnpm run demo -- --file /path/to/export_redacted_claude_main_20260522_152343.json
```

Replays a trace summary export (see the dashboard's **Export** tab). Only works with **redacted JSON** exports — full-fidelity or CSV/Markdown exports aren't supported as replay input.

> Trace summary exports (redacted or not) can't currently reconstruct full per-turn timelines for replay — they carry the trace's aggregate/summary fields, not raw OTEL span data, which TraceRoost doesn't persist to disk. This is tracked as a planned enhancement.

## Generating and validating fixtures for tests

Separate from the demo/capture flow above — these back the automated test suite, not live demos:

```bash
pnpm run fixtures:generate    # (re)generate demo/fixtures/*.json from generate-fixtures.js
pnpm run fixtures:validate    # validate fixtures against the current summarizer logic
pnpm run fixtures:check       # generate + validate against a scratch dir, leaving repo fixtures untouched
```
