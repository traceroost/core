# Agent format break

An agent release changed something TraceRoost reads (a renamed record type or OTLP event, a key
that moved, a value that changed type) and TraceRoost shows *Missing data* or *Unrecognized data*
for it or, worse, quietly shows the wrong numbers. This is the routine fix, starting from a committed fixture.

**Target:** a confirmed break on a *Verified* agent (README → Supported agents) ships in a patch
release within 2 working days. Other levels: as soon as practical.

## Triggers

Any of these:

- An `agent-release` tracking issue retitled **format change found** or **verification failed to
  run**, with the mail that comes with it, from `.github/workflows/agent-capture.yml`, dispatched by
  `.github/workflows/agent-release-watch.yml` when the agent shipped.
- A failed nightly **Agent capture** run (`Nightly agent capture: format change found`).
- A user's **Report this** issue (agent, version, unknown names and counts, key/type structure).
- `traceroost doctor` exiting 1 on your own machine.

An issue retitled **check by hand** (Copilot Chat in VS Code, which has no headless mode, or an
agent listed in the repo variable `AGENT_CAPTURE_SKIP`, such as `cursor` when there is no key for
it) or **not captured (its secret is not set)** means nothing was checked automatically: do step 1
by hand. An agent in `AGENT_CAPTURE_SKIP` doesn't mail on its own release.

## 1. Reproduce: get a capture of the new version

**From CI** (Claude Code, Codex, OpenCode, Cursor CLI, Copilot CLI): download the run's
`agent-capture-<agent>-<run id>` artifact. It already holds redacted fixtures
(`agent-fixtures/<agent>/<version>/`) and the fingerprint diff (`fingerprint-diff.md`). To capture
again, run **Agent capture** from the Actions tab with the agent and version; Cursor always installs
its latest. Each agent needs its secret: `ANTHROPIC_API_KEY` (Claude Code, OpenCode),
`OPENAI_API_KEY` (Codex), `CURSOR_API_KEY`, `COPILOT_GITHUB_TOKEN` (a fine-grained token with the
Copilot Requests permission).

**By hand** (Copilot Chat, or any agent without its secret), on a throwaway account or with a
throwaway prompt. The capture is redacted, but read it before committing anyway:

1. Install the reported version. Make a scratch git repo, and in it give the agent one short task
   that creates a file and reads it back.
2. Copy its log files into a capture directory using the layout `tests/e2e/captures-to-fixtures.mjs`
   documents (`claude-projects/`, `codex-sessions/`, `copilot-session-state/`, `cursor-projects/`,
   `opencode/opencode.db`). Copilot Chat: copy the session's
   `workspaceStorage/<hash>/chatSessions/<id>.jsonl` and write its fixture directory by hand on the
   model of `src/test/fixtures/agents/copilot_vscode/synthetic/`.
3. `node tests/e2e/captures-to-fixtures.mjs <capture dir>`. It refuses to finish while a home path,
   e-mail address or token-shaped string survives redaction.

**Antigravity CLI (`agy`)** has no CI capture and no committed real fixture yet (*Best effort*, built
from agentsview's third-party evidence; README → Antigravity CLI lists what a first capture must
confirm). `captures-to-fixtures.mjs` doesn't know its layout: copy one conversation's
`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`,
`conversations/<id>.db` (after the agent exits, so the WAL is checkpointed), `history.jsonl` and
`cache/last_conversations.json` into `src/test/fixtures/agents/antigravity/<version>/files/.gemini/antigravity-cli/`
on the model of the `synthetic/` fixture, redact prompts and paths by hand, and record the database's
schema fingerprint (`traceroost doctor` shows it as the version: `1.0.7–1.0.10` or `agy-schema:<hex>`)
in the manifest. Run `agy --version` for the version itself; nothing on disk records it.

Do not test the TraceRoost collector against your real agents: it rewrites `~/.claude`, `~/.codex`
and VS Code settings to its port. Run it with `HOME` set to a temporary directory.

## 2. Commit the fixture: the failing contract test is the spec

Put the new version's directory under `src/test/fixtures/agents/<agent>/<version>/`, beside the
older ones (which must keep passing), then:

```sh
pnpm run compile-tests
pnpm exec mocha --no-config --require src/test/setup.js --ui tdd out/test/test/adapters.contract.test.js
```

It fails on the unknown record names or the missing required key. That failure is what step 3
makes pass. Keep at least the oldest supported and the latest version per agent; past ~5 MB of
fixtures, prune the versions in between (the suite enforces the cap).

## 3. Fix the adapter

- **Parsing:** `src/logReader.ts` (log files and SQLite), `src/otlpIngest.ts` and
  `src/summarizers/` (OTLP). Parsing stays there.
- **Vocabulary:** `src/adapters/<agent>/known.ts`. Add new record names to `consumed` (with their
  required keys) when the parser reads them, or to `ignored` when it deliberately skips them. Add a
  key path to `structural` only if it holds no free text. List a field the parser reads when it's
  there (a token count, the model) under `reads`: the CI format check fails when a new version
  stops writing one the newest fixture had.
- **Totals:** `UPDATE_AGENT_FIXTURES=1` and the contract suite writes the new version's
  `expected.json`. Check its traces, turns, tokens, tool calls and cost by hand against the capture
  before committing; that file is the record of what's right.
- **Verified version:** set `lastVerifiedVersion` in `src/adapters/registry.ts`, paste
  `supportMatrixMarkdown()`'s output between the README's support-matrix markers (a test fails until
  you do), and add the change to `CHANGELOG.md`.

Then `pnpm run test:unit` and `pnpm run lint`, and run `traceroost doctor` against your own
logs: the agent should no longer show *Missing data* or *Unrecognized data*.

## 4. Release and close the loop

One branch and one PR per break. Cut a patch release ([`RELEASING.md`](RELEASING.md)). Then close
the tracking issue and any user reports, naming the version that has the fix.
