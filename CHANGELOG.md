# Changelog

All notable changes to TraceRoost (formerly AgentLens) are documented here.

## [Unreleased]

### Changed

- **AgentLens is now TraceRoost.** Several unrelated projects already use the AgentLens name. This release completes the rename across the whole project:
  - Extension published as `traceroost.traceroost-dashboard`; npm package `traceroost-dashboard`; CLIs `traceroost` / `traceroost-dashboard`; Docker image `traceroost/traceroost`.
  - VS Code settings moved from `agentLens.*` to `traceRoost.*`; commands from `agentLens.*` to `traceRoost.*`; the activity-bar view container is now **TraceRoost**.
  - Background service label is `com.traceroost.server`; the local data directory is `~/.traceroost`; environment variables are `TRACEROOST_PORT` / `TRACEROOST_MAX_SPANS`; the Claude Code stop-hook marker is `~/.traceroost/pending-prompt.txt`.
  - New brand assets: `media/brand/` (wordmark + mark, with on-dark / mono / current-colour variants), regenerated activity-bar icon and marketplace icon, and a theme-adaptive inline mark in the dashboard.
- **Upgrading from AgentLens is a clean break — no automatic migration.** After updating:
  - Re-run `npx traceroost-dashboard@latest service install` if you use the background service (the old `com.agentlens.server` service can be removed with `agentlens service uninstall` beforehand).
  - Let auto-config rewrite your agents' OTEL settings on their next start, or click **Configure OTEL** in Settings. Old `agentLens.*` settings values are not carried over.
  - Session history under the old `~/.agentlens` directory is not moved; pass `--data-dir ~/.agentlens` if you need it, or copy its contents into `~/.traceroost`.
- The `agentlens-dashboard` package continues to receive critical fixes from the [`agentlens`](https://github.com/traceroost/core/tree/agentlens) branch.

---

## [0.15.4] — 2026-09-07

### Fixed

- **Claude Code sessions with multi-block assistant responses over-counted tokens, turns, and cost** — Claude Code persists one assistant message as one JSONL line per content block (a text block plus N `tool_use` blocks — the common agent shape), and every one of those lines repeats the same `message.id` and the same `message.usage`. AgentLens billed each line independently, so a response split across four blocks counted its usage (and its turn) four times, inflating session cost and token totals for essentially every agentic Claude session. Usage is now reconciled to a single snapshot per message identity — greatest `output_tokens`, since Claude's output count is cumulative within a request, with later records winning ties — while every content block still parses for tool, file, and timeline data. Affected sessions re-cost themselves on the next log rescan, no manual action needed (#239)

### Changed

- **Sessions conversation bar is ~35% wider** — the colored left-edge bar marking rows that belong to the same split conversation went from 4px to 5px (6px to 8px when that conversation is isolated), making it easier to spot and a larger click target for the click-to-isolate gesture. Cosmetic; no behavior change (#238)
- **Repository and documentation links now point to `traceroost/core`** — the repository, issue, CLA, README, and in-app documentation links moved to the new GitHub location for the in-progress TraceRoost rebrand. The npm package (`agentlens-dashboard`), VS Code publisher, Open VSX identity, and Docker image are unchanged, and tagged releases still publish to the existing AgentLens destinations — no user-facing product change (#240)

---

## [0.15.3] — 2026-09-01

### Fixed

- **`agentlens service install` on an already-installed service printed a raw error the first time and only succeeded on a re-run** — on macOS `launchctl bootout` returns before the old service has finished unloading, so the immediate re-`bootstrap` raced it, failed with `Bootstrap failed: 5: Input/output error`, and surfaced as an uncaught stack trace. `install` now waits for the old service to fully unload before re-registering (with a bounded retry for the residual race); on Windows it stops any running instance and waits for it to release its ports before recreating the task (#237)

### Changed

- **`agentlens service install` output is more informative** — it now prints the AgentLens version, says when it's replacing an existing service, keeps the existing dashboard access token across a reinstall instead of rotating it (so bookmarked `?token=…` URLs keep working), waits for a health check before reporting success and printing the dashboard URL, and on failure prints a one-line reason and rolls back the partial install rather than dumping a stack trace. `service status` now distinguishes "installed but not reachable" from "nothing installed" (#237)

---

## [0.15.2] — 2026-09-01

### Fixed

- **`npx` / `bunx` instructions now pin `@latest`, so a stale cache can't silently keep you on an old version** — a bare `npx agentlens-dashboard` re-runs whatever version npx cached the first time it was invoked and never revalidates against npm, so you could stay on an old release for weeks while `npm view` still reported the new one (the README's quick-start comment even claimed the bare form always used the latest). Every documented `npx`/`bunx` command and the global `npm install -g` now use `@latest`, with a note on clearing the npx cache (`rm -rf ~/.npm/_npx`), and the standalone server now prints a one-line reminder at startup when it detects it was launched via `npx` that the running version may be a cached copy (#236)

---

## [0.15.1] — 2026-09-01

### Added

- **`agentlens service install` now moves the background service to the latest published version** — the service definition points at a fixed path to whatever `cli.js` launched `service install`, and nothing ever refreshed it, so an older global install already on `PATH` (or a stale npx cache) could leave the background service a release or more behind with nothing said. When run from a global install, `service install` now fetches `agentlens-dashboard@latest` first and points the service at that copy, so re-running it is a supported way to upgrade alongside `service update`. If the download fails (offline, registry down) it prints a clear one-line notice naming the likely cause and continues on the version already installed rather than aborting. A dev checkout is left untouched. The documented command is now `npx agentlens-dashboard@latest service install` (#234)

### Fixed

- **Imported Copilot VS Code sessions on dotted-version Claude models were costed at $0.00** — Copilot VS Code emits model IDs like `claude-opus-4.8`, while the rate table keys them `claude-opus-4-8`. The pricing lookup normalized only case and a trailing date suffix, then did an exact match, so the dotted ID missed, no rate was found, and the session's `cost_usd` computed as zero despite real token usage on a known, priced model. Lookup now collapses `.`, whitespace, and `_` to `-` on both the incoming ID and every rate-table key, so the two spellings resolve to the same rate in either direction. Affected sessions re-price themselves on the next log rescan — no manual action needed (#233)

### Changed

- **Model pricing refreshed** — added Claude Fable 5.1 and Claude Mythos 5.1 (new on Anthropic's pricing page; cache reads billed at 0.025x base input rather than the usual 0.1x) and two new free OpenCode Zen evaluation models. All existing rates re-verified against each vendor's current pricing page and unchanged (#235)
- **Stopped tracking the generated `media/dashboard.css` bundle** — it is a build artifact regenerated on every build and had drifted from source in the repo; no user-facing change, the published package and extension always ship the freshly built file (#232)

---

## [0.15.0] — 2026-08-29

### Added

- **Sessions table marks and lets you isolate conversations split across multiple cards** — splitting log-sourced sessions on prompt boundaries means one real conversation with an agent can now show up as several separate rows, often far apart since the list is time-sorted and unrelated sessions land between them. A colored bar on the left edge of a row now marks sessions that share an originating log file, with a hover tooltip giving its position (e.g. "Part 2 of 5"). Clicking the bar isolates the table to just that conversation — a banner names the conversation's first prompt with a "Show all sessions" button to clear it, or click the same bar again to toggle off. Added a "Conversation" glossary term explaining the concept (#229, #230)

---

## [0.14.0] — 2026-08-28

### Added

- **Configurable Sessions list pagination** — the Sessions table previously rendered its entire matching list with no cap for the "All time" view and no way to limit how many rows render at once, with total session counts only likely to grow given the prompt-boundary splitting below (one log file can now yield many session cards instead of one). Adds a page size setting (25/50/100/250/500, default 50, persisted across reloads) with Prev/Next controls shown both in the table's own footer and alongside the Time/Agent filters at the top (#226)

### Fixed

- **Log-sourced sessions merged an entire day's (or longer) work into one card instead of splitting on actual conversation boundaries** — Claude Code, Codex, and Copilot VS Code each write one log file per work session on disk, but a single file can span many genuinely separate prompts/conversations hours or days apart; AgentLens treated the whole file as one session, producing durations of 50+ hours that weren't real. Sessions are now split on prompt gaps (a 30+ minute idle gap between turns) for all three log-sourced formats, so each card reflects one actual interaction (#225)
- **Help page section nav wrapped tall and clipped off the right edge at narrower widths** — the horizontal pill row grew multi-line for longer labels and hid overflowing pills with no visible way to reach them. Replaced with a sticky sidebar list that highlights the current section as you scroll (#228)

### Changed

- **Sessions table footer** — dropped the "N sessions stored — managed by retention policy" line (redundant with the filter row's own session count) and shows the running AgentLens version there instead; removed the now-duplicate version display from the Help page nav (#227)

---

## [0.13.0] — 2026-08-27

### Added

- **Local auth token and Host-header validation for the standalone servers** — the UI, OTLP, and MCP servers were previously reachable by any process or web page on the machine with zero access control once `BIND_HOST` was set non-loopback. Adds a bearer token generated at first run, Host-header validation against the DNS-rebinding vector, and a startup refusal if a non-loopback bind somehow has no token in place. Also adds an unauthenticated `/health` endpoint for liveness checks, since `agentlens service status` and the Dockerfile healthcheck previously probed the now-gated `/` (#214)
- **System/Dark/Light theme toggle for the standalone dashboard** — standalone previously hardcoded a single dark palette with no light option and no OS/browser preference detection. New three-state toggle at the top of Settings, persisted across reloads; the VS Code webview is unaffected and continues to follow the IDE's own theme as before (#218, #222)
- **Three new loop/malfunction signals**: `chronic_tool_failures` (an unusually high share of a session's tool calls failed), `context_flooding_risk` (a tool result too large for the model to use well), and `malformed_tool_call` (the agent's own harness rejected a call before it even ran). The first two are promoted from ad-hoc checks that existed only in the Insights tab, invisible to MCP tools and the Instruction Advisor's cross-session aggregation; the third is new. Extends the loop-signal taxonomy from 5 to 8 (#217)
- **Two new post-hoc malfunction detectors**: `hallucinated_import` (an edit imports a package absent from the project's manifest and unresolvable on disk) and `failed_check_submission` (the session's last tool call was a failing test/build run with no further fix attempt before the session ended) (#216, #221)
- **Promotional-pricing note on the Pricing page** — a `‡` marker and hover note when a source explicitly labels a rate as promotional/temporary, using the vendor's own wording rather than a computed expiration date (#219)

### Fixed

- **Loop/malfunction detector accuracy** — `exact_tool_repeat` no longer treats a repeated verification command (tests, lint) run after each fix as a stuck loop; `edit_revert_cycle` only flags critical when the revert is still the file's final state when the session ends; `error_recurrence` normalizes dynamic substrings (temp paths, timestamps, hex ids) before grouping and caps less-certain label-fallback groupings below critical; `runaway_steps` weighs debugging/investigation language into its complexity estimate. All five existing signals are now tempered by a session's actual git outcome — a mid-session rough patch that recovered no longer reads at the same severity as one that never did (#215)
- **OTEL badge unreadable in light mode** — the per-session "OTEL" badge and the SOURCE filter bar's OTEL pill used a hardcoded white color, readable only against a dark background (#222)

### Changed

- **Model pricing refreshed** — `gpt-5.6-sol` and `gemini-3.6-flash` corrected for vendor price drops (both now labeled promotional, see above), several new models added (`gpt-5.6-cyber`, `gemini-3.7-flash`, `grok-4.6`, `gpt-4.1-nano`, `gpt-5-nano`, `gpt-5`), verified against each vendor's current pricing page (#219)

---

## [0.12.3] — 2026-08-23

### Added

- **`agentlens service update`** — the background service (installed via `agentlens service install`) never auto-updates; it keeps running whatever version was installed until updated manually. Previously that required two separate commands (`npm install -g agentlens-dashboard@latest` then `agentlens service restart`) documented only in a single README sentence, with no mention in the CLI's own `--help` text or the in-app Help page. The new command does both steps together, reports the before/after version, and is now surfaced in all three places (#212)
- **Version number shown at startup and on the Help page** — the VS Code extension's output channel and the standalone server's startup banner now log the running version as their first line, and the in-app Help page shows it in the upper-right corner of its navigation bar, in both VS Code and standalone/npx mode (#211)

---

## [0.12.2] — 2026-08-23

### Fixed

- **Codex sessions that finalized an edit via `git add`/`git commit` (or other git write/history-rewriting subcommands run through the shell) weren't counted as file changes** — a regression from v0.12.0's read-vs-write shell-command classification fix (#205), which only recognized a narrow set of write signals (redirection, `sed -i`, `mv`/`cp`/`rm`, `git apply`) and missed the common workflow of `git add <file> && git commit`, so every file staged/committed via shell was misclassified as merely read instead of changed. Added `add`, `commit`, `rm`, `mv`, `restore`, `checkout`, `cherry-pick`, `revert`, `merge`, `rebase`, and `stash` to the write-signal list (#210)

---

## [0.12.1] — 2026-08-18

### Fixed

- **`npx agentlens-dashboard service install` didn't work**, introduced in v0.12.0's background-service feature. Two compounding bugs: (1) after bootstrapping a global install, the re-exec inherited the parent process's environment, including the original `npx`-flavored `npm_config_user_agent`, so the freshly-installed child still looked like it was running via `npx` and bootstrapped again, endlessly, until manually interrupted (#208); (2) even with that fixed, re-invoking `agentlens` by name still resolved through `PATH` to the stale npx-cached copy rather than the new global install — npx prepends its own cache's bin directory to `PATH` for its entire process tree — so the fixed recursion guard correctly refused to loop again but surfaced as an uncaught crash instead of completing. The re-exec now resolves and runs the newly-installed global copy directly via `npm root -g`, sidestepping `PATH` lookup entirely, with a hard recursion guard as a backstop against any other undiscovered path to the same failure mode (#208, #209)

---

## [0.12.0] — 2026-08-18

### Added

- **Background Service mode** — `agentlens service <install|uninstall|start|stop|restart|status|logs>` installs the standalone server as an OS-native background service (macOS `launchd`, Linux `systemd --user`, Windows Scheduled Task at logon), so it survives a closed terminal, sleep, or reboot instead of silently losing incoming OTEL data whenever nothing is running to receive it. `npx agentlens-dashboard service install` works as a single command even with no prior install — it bootstraps a global install first, then continues (#207)
- **Automation triggers exposed via a new MCP tool** — `check_automation_triggers` lets an agent poll Automation's threshold state directly over MCP, alongside the existing notification/prompts-file delivery paths (#197)

### Fixed

- **Export silently truncated to 25 sessions for any bounded time range** (Today, Last 7 Days, Last 30 Days, custom range) — Export reused a signal deliberately capped for chart/table rendering, so choosing any range other than "All" exported only the first 25 matching sessions with no indication anything was cut off, contradicting the documented "full session history" export behavior. Also adds a missing `dataSource` field and `filesRead` section to CSV/Markdown export output (#203)
- **Copilot sessions with a broken telemetry parent-span link showed an empty Tools/Files tab** despite clearly running tools and editing files — added a same-trace fallback for the case where a Copilot session's tool spans never resolve back to their parent (#201)
- **Codex sessions using `apply_patch` showed an empty Files tab** — its arguments are a unified-diff patch string, not the `filePath`/`path` shape AgentLens expected, so file paths were silently dropped while tool-call counts stayed correct, making the gap easy to miss (#202)
- **Codex sessions could show files as modified that were only read** — a shell-command fallback used to extract file paths from Codex's `exec_command` tool calls pulled every file-looking path out of the raw command string regardless of whether the command actually wrote anything, so a read-only command like `cat foo.ts` or `rg pattern foo.ts` marked `foo.ts` as changed (#205)
- **Sidebar token-usage bar averages could be skewed by a single unusually long session** — averaged across a session's entire history instead of the 5 most recent, so with few total sessions one outlier could dominate the bar scaling for everything else (#204)

### Changed

- Several in-app Help/README wording and accuracy fixes: corrected the Git Outcome Correlation VS-Code-only claim, clarified Clear All Data's actual scope, fixed inaccuracies in the Automation/Advisor sections, documented the previously-missing `get_instruction_suggestions` MCP tool, and reorganized/tightened the Setup "not seeing data" callout. No user-facing product behavior change (#196, #198, #199, #200, #206)

---

## [0.11.0] — 2026-08-17

### Added

- **Pricing page** — a new `$` icon in the header, next to Help, opens a page showing the exact rate table AgentLens uses to estimate cost: every model, grouped by vendor (OpenAI, Anthropic, Google, fine-tuned/third-party Copilot-marketplace models, OpenCode Zen), each with a "verified `<date>`" and source links as footnotes. An "Uncategorized" fallback section guarantees a model can never silently go missing from the page even if a future pricing refresh forgets to sort it into a vendor group (#194)

### Fixed

- **A Codex or Claude fast-mode session's cost could be silently wrong.** Three related gaps found while auditing the cost-estimation system: (1) `lookupRates()`'s substring-prefix fallback could mis-price a brand-new, unrecognized model by matching it against an older, unrelated model already in the rate table instead of showing the intended "unknown model" indicator — removed; (2) Claude Code fast-mode (`/fast`) sessions with a date-suffixed model ID (a common shape) were silently priced at the standard rate instead of the real fast-mode rate — up to 6x underestimated — fixed by stripping the date before appending the fast-mode marker; (3) fast mode is undetectable at all for Claude Code sessions ingested via OTEL rather than the local log file — this appears to be a gap in what Claude Code's OTEL telemetry exposes rather than something AgentLens can read around, so it's documented as a known limitation in `PRICING_SOURCES.md` rather than fixed in code (#195)

### Changed

- Established a runbook (`runbooks/RELEASING.md`) for cutting releases. No user-facing product change (#193)

---

## [0.10.1] — 2026-08-15

### Fixed

- **Codex sessions never populated the Context Growth chart or triggered the token-runaway "Infinite Loop — Context Accumulation" signal** — a Codex turn's per-turn token usage is carried on its `tool_decision` span for most sessions, and that span updated aggregate session totals but never wrote a timeline entry, so both features always saw zero turns for any Codex session, real or demo. Codex's Context Growth chart and that Automation signal now work like Claude's and Copilot's (#192)

### Changed

- Expanded the internal demo tooling (`pnpm run demo`) with a new multi-agent "story" scenario — a 10-chapter petstore build-out told from Codex's, Claude's, and Copilot's perspectives — plus a `--cdp` flag to reuse an already-open demo browser instead of launching a new window each run. No user-facing product change (#192)

---

## [0.10.0] — 2026-08-12

### Added

- **Git outcome correlation** — for each file a session changed, compares its content before and after against local git history to show whether the work was committed, reverted, or left uncommitted after the fact — answers "did this session's changes actually survive?" without checking git yourself. Computed on demand when a session's Files sub-tab is opened, with results cached for the life of the session. Works in both the VS Code extension and standalone/npx mode (#176, #182, #189, #190)
- **One-shot / retry-rate metric** — tracks what fraction of a session's edited files reached their final state in a single edit pass vs. needed retries, shown per-session in the Files sub-tab and aggregated per-agent in Analytics. A proxy for correction effort, not a correctness signal (#177, #183)
- **Daily cost threshold alert** — a new configurable alert (disabled by default, $20/day) that sums estimated cost across all agents for the current UTC day, using the same alert/notification plumbing as the existing threshold alerts (#175, #183)
- **CSV and Markdown export formats** — alongside the existing JSON export, sessions can now be exported as CSV (one row per session, for spreadsheets) or Markdown (one section per session, for sharing a report). JSON remains the only format the Import tab reads back in (#178)
- **Per-model long-context pricing surcharge** — cost estimates now correctly apply the "long context" pricing tier that several models (GPT-5.4, GPT-5.5, the GPT-5.6 family, Gemini 3.1 Pro, Grok 4.5) charge above a per-model token-per-call threshold — previously not modeled at all, silently under-billing large-context calls on these models (#187)
- New pricing entries: `gpt-4.1-mini`, `mai-code-1.1-flash`, and 7 newly-confirmed free OpenCode Zen models (#185)

### Fixed

- **Copilot sessions using Grok 4.5, Kimi K3, Kimi K2.7 Code, or MAI-Code-1-Flash silently stored $0 cost** since these models were added in v0.9.3 — they existed in the browser-side pricing table but were never added to the extension-host one that actually computes and stores `cost_usd`. Both tables now match (#185)
- **Claude Sonnet 5's rate table carried a scheduled increase to $3/$15 per million tokens on 2026-09-01** that would have silently changed displayed cost on that date — Anthropic has since cancelled the increase and made the current $2/$10 rate permanent (#185)
- **`agentLens.sessionRetentionDays` was invisible in VS Code's Settings UI** — the setting was read in code and documented in the README, but never registered in the extension's configuration schema, so it couldn't be found or set through Settings without hand-editing `settings.json` (#188)
- **`AgentLens: Show Storage Stats` never appeared in the Command Palette** — the command was fully implemented but missing from the extension manifest (#188)

### Changed

- Daily Cost Threshold now appears first in the Alerts settings list (#183)
- Small in-app Help/Traces documentation clarifications: an OTEL-vs-log-richness callout, clearer Codex OTEL setup/restart guidance, and a Codex trace interpretation note (#172, #173, #174)
- Added an Import tab section to the in-app Help documentation, which previously had none despite Import being a full feature (#188)

---

## [0.9.3] — 2026-08-07

### Fixed

- **Standalone dashboard's span store grew unbounded, eventually crashing every save** — spans accumulated in memory forever and were fully re-serialized to disk on every save; once the total exceeded V8's ~512MB max string length, `JSON.stringify` began throwing and saves failed silently forever (and, past that point, the persisted file became too large to even load back on restart). Spans are now capped (default 50k, configurable via `AGENTLENS_MAX_SPANS`), oversized existing files are backed up instead of crashing on load, and a save that still somehow fails self-heals by trimming and retrying. A pre-release review also caught and fixed two smaller issues in this same fix: `AGENTLENS_MAX_SPANS=0` was silently ignored in favor of the default, and a failed save on shutdown could still log a false "Saved" message (#169, #171)
- **Corrected model pricing** — `gpt-5.6-luna` and `gpt-5.6-terra` were overpriced (both have since been repriced down by the vendor and gained real cache-write pricing), `gpt-5.1` was overpriced ($1.75→$1.25 input), and `gpt-4.1` was showing as free when it's actually billed again. See `PRICING_SOURCES.md` for sources (#170)

### Added

- Claude Opus 5, Gemini 3.6 Flash, and two new Copilot-marketplace models (Grok 4.5, Kimi K3) to the cost/pricing tables (#170)

---

## [0.9.2] — 2026-08-01

### Changed

- **SEO metadata refresh** — `package.json` description/keywords and the README now mention "monitoring" and "agentic" alongside "observability" and "OTEL" so npm, VS Code Marketplace, and GitHub search surface AgentLens for those terms. Added alt text to README images. GitHub repo topics, homepage, and description updated to match (#168)

---

## [0.9.1] — 2026-07-26

### Fixed

- **Export tab claimed "All recorded sessions exported as JSON" but only exported the currently filtered subset** — a user who filtered down by Time/Agent/Source/text elsewhere in the app could silently export a partial subset while believing they got everything. Both export cards now show "N sessions matching your current filters" (#167)
- **Analytics daily-cost chart's x-axis date labels could overlap into illegible text** — the minimum-gap check compared day-group midpoints, but labels were rendered left-aligned at the group's start edge, letting labels drift into each other for days with more sessions. Render and gap-check now share the same anchor point (#167)
- **Flow graph rendered small/sparse sessions tiny in a mostly-empty canvas** — zoom was hard-capped at 1.4x regardless of available canvas space; raised to 2.2x (#167)
- **Session/Analytics/Advisor data tables gave no visual hint they were horizontally scrollable at narrow widths** (e.g. a resized VS Code panel) — overlay scrollbars are invisible until hover. Added a persistent thin styled scrollbar across all four scrollable tables (#167)

---

## [0.9.0] — 2026-07-24

### Added

- **"Configure OTEL" button in Settings** — manually re-applies AgentLens's OTEL configuration to Claude Code, Codex, and Copilot on demand, in both the VS Code extension and standalone. Useful when you've changed one of those agents' telemetry settings by hand and want it pointed back at AgentLens without waiting for the next restart (#166)
- **Notification on successful OTEL auto-configuration** — the VS Code extension now shows an info toast and logs to the Output panel whenever auto-configuration actually changes an agent's config, instead of doing so silently. Stays quiet once already configured, since the underlying write is idempotent (#166)
- **"Live · Current Session Activity" header** on the live session sidebar, in both the standalone dashboard's left panel and the VS Code extension's native sidebar view, making clear what that panel shows (#166)
- **Log-only sessions now explain why the Trace, Flow, Tools, and Files tabs are empty** instead of rendering silently blank, with a link to the Help tab's OTEL setup section (#166)

### Fixed

- **Standalone's live session sidebar no longer opens expanded by default** — it duplicated content already visible in the main dashboard; VS Code's own native sidebar is unaffected (#166)
- **Flow tab showed a nonzero LLM-call count next to an empty canvas** for log-only Codex/Copilot sessions — the tab label counts LLM calls from a field every ingestion path populates, but the canvas itself renders from the session timeline, which log ingestion leaves empty. Now shows a labeled empty state instead of a near-invisible canvas-drawn message (#166)
- **"Configure OTEL" button hung forever on "Configuring…" in standalone mode** — the standalone dashboard polyfills the VS Code webview API so its `postMessage` calls always take that code path instead of falling back to a direct fetch, but the polyfill had no handler for the new message type, so the request silently went nowhere (#166)

---

## [0.8.8] — 2026-07-19

### Fixed

- **Sessions using more than one model showed the wrong model and mispriced cost** — session cards reported whichever model happened to handle the *last* LLM call, even when a session legitimately used more than one (a Task-tool subagent on a cheaper model, switching models mid-conversation via `/model`). Cost was computed by pricing the session's entire token count at that one model's rate, so mixed-model sessions could be significantly over- or under-billed. Fix: the reported model is now the token-weighted dominant one, a full list of models used is exposed and shown as a "+N" badge in the Sessions tab, and cost is computed per LLM call at that call's own rate whenever a session's timeline shows more than one distinct model — applied consistently in both the extension's stored cost and the webview's live cost calculator, which had the same bug independently (#165)

### Added

- **`agentLens.autoConfigureAgents` setting** (default on) — the extension automatically writes OTEL telemetry settings into Claude Code's, Codex's, and GitHub Copilot's own configuration on activation; this is now an inspectable, toggleable setting instead of an unconditional side effect (#165)

---

## [0.8.7] — 2026-07-19

### Chore

- **Upgraded CI, release, and Docker to Node 24** — the release workflow's `publish-npm` job was broken on Node 20: `npm install -g npm@latest` now installs an npm version requiring Node `^22.22.2 || ^24.15.0 || >=26`, so the step failed before ever attempting to publish (this is what blocked npm publishing on v0.8.6). `ci.yml`'s test matrix, all three `release.yml` jobs, and both `Dockerfile` stages now standardize on Node 24 (current Active LTS); `package.json` gained an explicit `engines.node: ">=24"` (#164)

---

## [0.8.6] — 2026-07-19

### Fixed

- **Opus 4.6 fast mode billed at stale 6x rate** — Anthropic removed fast mode for Claude Opus 4.6 on 2026-06-29 (requests now run at standard speed and bill at standard rates), but the `claude-opus-4-6-fast` rate table entry still applied the old 6x multiplier. Sessions using Opus 4.6 fast mode were overpriced by roughly 5x. Fix: `claude-opus-4-6-fast` now matches the standard `claude-opus-4-6` rate in both `src/pricing.ts` and `media/src/pricing.ts` (#163)
- **gpt-5-mini, raptor-mini no longer free** — both models moved from GitHub Copilot's included/$0 tier to standard paid AI Credits rates ($0.25/$0.025/–/$2.00 per MTok); sessions using them were showing $0 cost. Fix: rate tables updated to the current paid rate (#163)
- **gpt-5.5 annual-plan multiplier stale** — `multiplierAnnualPostJun1` was 7.5, current Copilot docs show 57; annual-plan legacy-billing users on gpt-5.5 were significantly underpriced. Fix: corrected in `media/src/pricing.ts` (#163)

### Added

- **New models** — `claude-sonnet-5` (introductory pricing through 2026-08-31), `claude-mythos-5`, the `gpt-5.6` family (Luna/Terra/Sol), and new Copilot marketplace models `mai-code-1-flash` / `kimi-k2.7-code` (#163)

### Docs

- `PRICING_SOURCES.md` restructured as a current-state reference and refresh runbook instead of an accumulating changelog; every listed source re-verified and new known gaps documented (data residency multiplier, Copilot code review multiplier, unconfirmed OpenCode Zen free-model IDs) (#163)

---

## [0.8.5] — 2026-06-15

### Fixed

- **First session in standalone Traces tab never loads timeline** — The first session in the Traces tab starts expanded by default, but `loadSessionDetail` was only dispatched inside `toggle()`, which fires on user click. The auto-expanded session would show "Loading timeline…" indefinitely until the user manually collapsed and re-expanded it. Fix: add a `useEffect` that fires on mount (and whenever `collapsed` changes) to dispatch the fetch whenever the session is expanded but its timeline has not yet loaded (#161, #162)

---

## [0.8.4] — 2026-06-14

### Fixed

- **Per-turn token costs wrong for cached Claude turns** — `TimelineEntry` had no `cacheReadTokens` / `cacheCreateTokens` fields, so `calcEntryCost` passed zeros for both cache tiers and billed every token at the full input rate. A turn with 100 K total context where 90 K is cached was priced ~5–10× too high, and costs looked uniform across turns because the inflated formula only grew with the slowly-expanding context window. Fix: add the two optional fields throughout the pipeline (summarizer, DB schema + migration, writer, reader, webview types) and update `calcEntryCost` to apply the correct cache-read (10%) and cache-write (125%) rates. The Traces tab StepRow compact display now shows total tokens and cache-read count on two short lines that fit the 90 px column instead of a single overflowing string (#157, #159)
- **Standalone server locks up Safari on load** — `getHtml()` inlined `window.__INITIAL_SPANS__` (the full raw spans array, never consumed by the Preact app — potentially multiple MB) and full per-session timeline arrays inside `__INITIAL_SESSION_SUMMARY__`, all synchronously in `<script>` tags before `dashboard.js` could evaluate. Safari's JavaScriptCore parses large inline scripts on the main thread with no incremental yield, freezing the page immediately after first paint. The raw spans array was also re-sent in every SSE update payload. Fix: remove `__INITIAL_SPANS__` entirely, strip timeline arrays from the inline summary, add `/api/summary` and `/api/timeline/:sessionId` endpoints for lazy loading, wire `loadSessionDetail` in the `acquireVsCodeApi` shim to fetch timelines on demand, and add an SSE `onerror` → 2-second polling fallback so Safari private mode (where ITP blocks `EventSource`) shows live data instead of a frozen page. Diagnostic `console.log` timestamps are now emitted at key load stages to aid future cross-browser diagnosis (#158, #160)

---

## [0.8.3] — 2026-06-14

### Fixed

- **OOM crash during long Claude Code sessions with enhanced telemetry** — `genAiResponseBuffer` in the OTLP collector leaked one large JSON blob per LLM call when the `claude_code.llm_request` span arrived before its matching `gen_ai.choice` log event (the common ordering with `gen_ai_latest_experimental`). `processTraces` deleted buffer entries when it consumed them, but when the span was already in the store by the time the log arrived, `processLogs` injected immediately and never cleaned up its own entry. Over a long session the buffer accumulated the full accumulated conversation context for every turn, growing the heap to the 4 GB V8 limit and crashing VS Code. Fix: check `injectSpanAttribute`'s return value and delete the buffer key immediately on successful injection. A 500-entry LRU-style cap also guards against orphaned entries when a span is dropped by the agent's OTLP exporter (#155, #156)

---

## [0.8.2] — 2026-06-11

### Fixed

- **Windows: Codex and Copilot CLI sessions not discovered** — `codexSessionsDirs()` and `copilotSessionStateDir()` only checked Unix-style home-directory paths. On Windows, Codex likely stores sessions under `%LOCALAPPDATA%\Codex\sessions` or `%APPDATA%\Codex\sessions`, and Copilot CLI under `%APPDATA%\copilot\session-state`. Both are now checked as primary candidates on `win32` before falling back to the `~/.codex` / `~/.copilot` paths, matching the existing pattern used for Claude Code (#153, #154)

---

## [0.8.1] — 2026-06-11

### Fixed

- **Standalone UI hangs empty on startup** — `startLogIngestion()` awaits sql.js before scanning, so the browser frequently connects to the SSE `/events` endpoint during that async gap and receives an empty payload. After the scan completes and `logSessions` is populated, `fileState` is fully current so the 5-second `runLogScan` poll finds no changed files and never pushes an update — the dashboard stays blank indefinitely. Fix: call `pushUpdate()` at the end of `startLogIngestion()` to flush sessions to any already-connected SSE clients (#151, #152)

---

## [0.8.0] — 2026-06-10

### Added

- **OpenCode support** — AgentLens now reads OpenCode's local SQLite database (`~/.local/share/opencode/opencode.db` on Mac/Linux, `%APPDATA%\opencode\opencode.db` on Windows) directly, with no agent configuration required. Sessions, messages, parts (tool calls, file accesses), and token counts are all parsed; the WAL is merged at read time so sessions appear immediately after each run. Subagent sessions (`parent_id` set) are excluded. Falls back to reading `storage/message/*.json` files when the SQLite driver is not available (Docker). Override the default path with `OPENCODE_DATA_DIR` (comma-separated for multiple directories). Windows path (`%APPDATA%\opencode`) is also checked automatically (#147)
- **Import tab** — New **Import** tab in the dashboard accepts an AgentLens JSON export file (drag-drop or file picker), shows a preview with session count by agent source and date range, then imports with live progress updates. Sessions already present in the local database are skipped automatically. Works in both VS Code extension mode and standalone server mode. The standalone server adds a `/api/import` endpoint for the batched POST path (#148)
- **Pricing: claude-fable-5** — Added `claude-fable-5` to both pricing tables at `$10/$50` per MTok input/output with a 1 M token context window (#150)
- **Pricing: big-pickle** — Added `big-pickle` (OpenCode's stealth model, free during limited evaluation) to both pricing tables (#147)

### Fixed

- **Import hang in VS Code** — Importing sessions previously blocked indefinitely because `drain()` returned the shared `drainPromise`, which could be an in-flight log-reader drain waiting on async blob writes. Import now uses a dedicated `importCards()` synchronous transaction path that bypasses the drain pipeline entirely (#148)
- **Import progress stuck at 0 in standalone** — Standalone HTML injects `window.acquireVsCodeApi` as a shim, making `vscode` truthy even in browser mode. The Import tab now checks `window.__STANDALONE__` to route correctly, and sends sessions in 50-session batches so progress updates are visible during large imports (#148)
- **Context window values for 1 M-context models** — `contextWindowTokens` corrected from `200_000` to `1_000_000` for all Opus 4.x, Sonnet 4.x, and Opus fast-mode entries; these models have supported 1 M context since Opus 4.6 (#150)

## [0.7.3] — 2026-06-09

### Fixed

- **sql.js not resolvable in packaged extension** — `require('sql.js')` failed with `Cannot find module` in installed extensions because `sql.js` was marked external in esbuild but `node_modules` is excluded from the `.vsix`. `sql-wasm.js` is now copied to `dist/` at build time and required by path; covers both the primary window (`openDatabase`) and secondary sync windows (`openReadonlySnapshot`) (#141)
- **Friendly EADDRINUSE errors** — MCP (port 4316) and UI (port 3000) servers now print an actionable message and exit cleanly on port conflict instead of crashing with a raw Node stack trace; all three servers (OTLP, MCP, UI) now use the same pattern (#140)

---

## [0.7.2] — 2026-06-08

### Fixed

- `media/help-mascot.png` removed from `.dockerignore`, `.vscodeignore`, and `.npmignore` — it is served by the VS Code webview, standalone server, and Docker image and must be included in all packages; only `media/demo.gif` is README-only

---

## [0.7.1] — 2026-06-08

### Added

- **Ingestion toggles** — new Settings tab with per-source ingestion toggles (Claude Code logs, Copilot logs, OTEL spans); each source can be disabled independently without clearing data

### Fixed

- **Fast mode cost multiplier** — fast mode sessions now apply the 5× cost multiplier from the `usage.speed` field; was previously ignored, causing fast mode sessions to be underpriced (#124)
- **Tiered pricing for claude-sonnet-4** — input tokens above 200 K now apply the correct surcharge tier; the `calcTokenCostUsd` calling convention was also corrected to pre-subtract cache tokens before tier lookup (#130)
- **Copilot OTEL token convention** — GPT-model Copilot sessions use the OpenAI token convention (`input_tokens` = total context including cached); the summarizer no longer double-counts cached tokens when `cacheRead` is non-zero (#133)
- **Unpriced sessions excluded from cost chart** — sessions with unrecognized model IDs (grey `?` markers) are now filtered out of the ESTIMATED COST bar chart; they contributed $0 to all calculations but consumed slots and created visual noise; a footnote reports how many were excluded (#135)
- **"Clear All Data" visually confirms** — post-clear re-ingestion delay increased from 500 ms to 5 s so the cleared state is visible before sessions reload (#136)
- **Dashboard picks up log scan results** — `DashboardPanel.update()` is now called after every `runLogScan` drain; previously the dashboard could lag up to 40 s behind the sidebar after a log scan (#136)

### Chore

- `media/demo.gif` and `media/help-mascot.png` (README-only assets) excluded from `.vscodeignore`, `.dockerignore`, and `.npmignore`
- Updated demo GIF

---

## [0.7.0] — 2026-06-07

### Added

- **Advisor tab** — new tab (merged into the Patterns tab area) with three sub-panels:
  - *Instruction Advisor* — surfaces per-workspace suggestions derived from session patterns: hot file guidance, loop prevention rules, scope discipline, tool discipline, and discovery prompts; each card shows the suggested text and an "Apply to file" button with a file-picker dropdown targeting detected instruction files (CLAUDE.md, .cursorrules, etc.)
  - *Instruction Effectiveness* — tracks the before/after impact of applied suggestions; compares cost-per-session and turns-per-session in a 20-session window before vs. after each applied suggestion; surface area shows `baselineCostAvg`, `postCostAvg`, delta, and a trend indicator; requires at least 5 post-apply sessions to report
  - *Prompt Analyzer* — pre-session cost prediction and context advice (foundation for issue #119)
- **Hot Files — Written mode** — new toggle on the Patterns tab Hot Files panel; switches from "files read most" to "files fully written by the agent"; files where the agent overwrote the entire content are ranked by session count; tip box adapts to Written mode with guidance on what fully-written files indicate
- **Instruction file apply/remove** — suggestions can be applied directly to a target file (appends a marked block `<!-- AgentLens suggestion applied -->`); remove clears the block; both VS Code extension and standalone server support apply/remove; standalone adds `POST /api/instructions/apply` and `DELETE /api/instructions/applied/:id` endpoints
- **Effectiveness persistence** — `instruction_applied` and `instruction_dismissed` SQLite tables store applied suggestion records, baseline snapshots, and dismissed IDs per workspace; `InstructionRepository` and `InstructionEffectiveness` modules implement the full persistence and computation layer
- **Understanding Cost Estimates** — new Help section explaining how costs are derived, why estimates differ from billing, what "accumulated" means for multi-turn cached sessions, and known gaps per agent

### UX

- **$0.00 row suppression** — cost table hides rows with zero estimated cost by default; "Show $0" toggle reveals them; reduces visual noise for agents that produce no billable activity in the window
- **Cost disclaimer link** — `?` link on the "ESTIMATED COST" heading and in the disclaimer bar jumps to the Understanding Cost Estimates Help section
- **Accumulated token display** — tooltip clarifies that token counts for cached sessions represent accumulated totals across the turn chain, not per-turn usage

### Fixed

- **Strict equality** — replaced all `!= null` / `== null` comparisons with `!== null` / `=== null` (eqeqeq lint rule) across App.tsx, sidebarWebview.ts, reader.ts, and sessionRepository.ts
- **Stale instruction files on workspace switch** — switching the workspace filter to "All" now clears the `instructionFiles` signal, preventing stale file options from a previous workspace appearing in the Apply dropdown
- **Standalone remove endpoint** — VS Code extension had `removeInstructionSuggestion` message handling but standalone had no HTTP endpoint; added `DELETE /api/instructions/applied/:id` that scans all session workspaces

---

## [0.6.1] — 2026-06-06

### Added

- **Workspace filter** — new dropdown in the filter bar surfaces the project path for each session and lets you narrow the view to a single workspace; works across Sessions, Analytics, Patterns, and Export tabs
- **Cross-source workspace resolution** — OTEL-traced sessions (Claude Code, Codex) that lack a workspace attribute are matched to a log-ingested session from the same source that started within the same minute; the resolved workspace propagates to the OTEL session for filter purposes
- **Codex workspace from session_meta** — Codex sessions now read `session_meta.cwd` as the workspace path instead of the date-based directory name

### Fixed

- **Workspace in live sessions** — OTEL span attributes (`process.cwd`, `session.workspace`) are now extracted and surfaced in live (in-memory) sessions, not just persisted ones
- **Workspace filter applied to DB results** — `rangedSessions` was not applying the workspace filter to SQLite query results; fixed to filter in the DB layer

---

## [0.6.0] — 2026-06-05

### Added

- **Patterns tab** — new cross-session behavioral analysis tab with two panels:
  - *Efficiency Map* — scatter plot (cost × LLM calls) colored by cache hit rate; click any dot to navigate to that session; top-10 table is sortable by time, cost, turns, or cache hit; each row shows an agent dot and a time hyperlink that jumps to the expanded session in the Sessions tab
  - *Hot Files* — files the agent accessed most often, ranked by session count; shows read and changed counts per file with a "last seen" date; tip box adapts per mode (Read / Changed / Both) explaining what to do about each pattern
- **MCP server** — Streamable HTTP server (port 4316) that gives Claude Code and other agents direct access to session history via five tools: `get_recent_sessions`, `get_workspace_patterns`, `get_session_detail`, `find_relevant_context`, `get_efficiency_report`; toggle in Settings; auto-starts with the extension; standalone server also runs on port 4316
- **Shared filter bar** — time range, agent, source, text search, and From (initiator) filters now appear on Sessions, Analytics, Patterns, and Export tabs; state retained when switching tabs; Reset available everywhere
- **Export respects filters** — export sends the active filtered session IDs to the backend; both VS Code and standalone export only what is visible, not the full database
- **Chart → session navigation** — clicking a bar in Estimated Cost or Token Usage Per Session, or a line in Context Growth, navigates to the Sessions tab and expands that session
- **Loop signals for log sessions** — `detectLoopSignals` now runs on log-reader sessions (was always empty); exact-tool-repeat and runaway-step signals now appear on log-sourced sessions
- **VS Code-family IDE coverage** — Copilot Chat log ingestion now scans Cursor, Windsurf, VSCodium, Trae, and Kiro workspace storage directories in addition to VS Code and VS Code Insiders
- **Improved ingestion logs** — span ingestion now shows agent name instead of a running total; session load shows per-agent breakdown with source directories
- **Context and Context Window** added to the Help glossary with precise definitions

### UX

- **Analytics section headers** — all-caps with letter-spacing; first section spacing tightened to match filter bar
- **Patterns section headers** — all-caps with letter-spacing, matching Analytics style
- **Context Growth chart** — most recent 25 sessions shown (was oldest 25); session count label; ◀▶ step buttons moved next to speed controls; fixed step buttons not highlighting when an external session focus was set
- **Context Growth bug fix** — chart was missing for log-sourced sessions because tool-using turns were classified as `type:'tool'` instead of `'llm'`; now correctly picks up turns with `inputTokens > 0` regardless of type
- **View Automations button** — automation popup now has a View Automations button to the left of Copy Prompt, matching the alert popup pattern
- **Padding and spacing** — added padding above sessions table, patterns content, and export cards
- **Export tab** — removed total session count header; removed "browser download" label

### Fixed

- **Analytics charts filter** — Estimated Cost bar chart, Token Usage Per Session, and Context Growth were not updating when the text filter or From filter changed; fixed to use `filteredSessions` (sorted by time) instead of `rangedSessions`
- **Refresh button stale range** — time range picker's Refresh button now writes the fresh `TimeRange` to the signal before calling `fireSearch`, fixing stale in-memory session boundaries after refresh
- **MCP workspace filter no-op** — `get_recent_sessions` workspace filter had `|| true` making it always pass; removed
- **logReader sparse array crash** — `Math.max(...turnTimestamps)` on a sparse array (turns with missing timestamps) threw `RangeError: Invalid time value`; now filters undefined entries first
- **Cost sort wrong pricing mode** — session sort by cost was pricing session B with session A's mode; fixed to derive mode per session
- **Session detail request on every render** — `vscode.postMessage({ type: 'loadSessionDetail' })` was called in the render body of `SessionDetail`, firing on every re-render; moved into `useEffect`
- **Export standalone fix** — standalone export was a no-op (re-dispatched message to window with no listener); now triggers a real browser download
- **Redacted export** — now replaces file paths with `[redacted]` in addition to prompt text
- **`scheduleWatchScan` debounce** — was leading-edge (only first event in a burst); converted to trailing-edge so scan fires 300ms after the *last* fs.watch event, preventing partial reads during streaming file writes

### Docs

- **Help — Patterns section** — new section in the TOC and content covering the Efficiency Map and Hot Files panels
- **Help — Export section** — corrected description; export now respects active filters
- **Help — Agent Integration** — CLAUDE.md block tightened to 2 lines; note added that brevity avoids context window bloat; standalone MCP URL corrected to port 4316
- **README** — Patterns feature bullet added; Export bullet updated to reflect filter-aware export
- **CLAUDE.md** — tightened to 2-line instruction block

---

## [0.5.0] — 2026-06-03

### UX

- **Navigation overhauled** — tab bar collapsed from six entries to three data views (`Sessions | Analytics | Export`); three icon buttons sit right-aligned in the header
- **Bell icon — active alert status** — badge shows the number of currently triggered alerts; click to open a compact status card listing each alert with severity, name, and detail text; "Configure alerts →" link jumps to the settings panel
- **Gear icon — settings panel** — slide-in panel (440px, scrollable) with collapsible Alerts and Automation sections, both open by default; close with × or Escape
- **Help icon** — replaces the Help tab; active state shows the same blue underline as tab buttons
- **SVG icons throughout** — bell, gear, help, and refresh buttons are all stroke-based SVGs using `currentColor`; same visual weight at any size, work in dark and light themes with no emoji rendering quirks
- **Severity dots in alert card** — alert card rows use small coloured circles instead of emoji for severity indicators
- **Tab bar alignment** — tabs now sit flush to the top of the view in both VS Code and standalone; standalone sidebar gets 8px top padding for breathing room
- **Agent key legend removed** — the `● Copilot ● Claude ● Codex` row at the top of the sidebar was redundant with the per-session agent indicator already shown in each card

### Fixed

- **Copilot Chat log ingestion** — added `_parseCopilotVSCodeFile` (delta-log JSONL) and `_parseCopilotVSCodeJsonFile` (legacy JSON snapshot) for `workspaceStorage/chatSessions`; handles three `completionTokens` formats (direct kind=1, embedded in kind=2 push, pre-June 2026 result.usage); fixes k.length===1 guard to prevent sub-array inflation of `requestPushCount`; two-phase startup loading (fast group batch=10, slow .json group batch=2 with 50ms gap) to keep extension host responsive
- **Copilot CLI session.shutdown** — reads `modelMetrics[model].usage` instead of `currentTokens` for correct token totals
- **Codex prompt extraction** — extracts user prompt from `event_msg payload.type=user_message`; strips IDE context preamble (`## My request for Codex:`) via `_extractCodexUserText`
- **Clear All Data** — `agentLens.clearSessions` command was registered but the button did nothing; now correctly clears pending queue and generation counter, refreshes UI before re-ingestion, and triggers `setImmediate(runLogScan)` in standalone so log sessions repopulate after clear
- **Standalone alert / automation notifications** — match VS Code UX: automation label format `Automation: <label>`, alert notifications use `showActionNotification` with View Alerts secondary action and 30s dismiss; `\n` escaping fixed in template literals to prevent broken inline JS strings

### Docs

- **Help — Settings section** — replaces separate Alerts and Automation sections in the Help TOC; describes the bell icon (badge, status card, Configure link) and gear icon (settings panel, collapsible sections)

### Chore

- **`.map` files gitignored** — `media/dashboard.js.map`, `media/dashboard.css.map`, `media/sidebar.js.map`, and `standalone/cli.js.map` are no longer tracked; all caused unresolvable conflicts on rebase because git cannot merge the base64 mapping blobs
- **Post-rebase/merge hooks** — `.githooks/post-rewrite` and `.githooks/post-merge` run `node esbuild.js` automatically so `cli.js` and other build artifacts stay in sync after any rebase or merge without manual intervention; `core.hooksPath = .githooks` set in project git config
- **`.claude/settings.json` gitignored** — per-developer Claude Code permissions config; was creating constant noise in `git status`

---

## [0.4.1] — 2026-06-03

### Docs

- **Help tab restructured** — dedicated sections for Sessions, Analytics, Alerts, Automation, and Export now mirror the app's tab layout; Insights and Loop Detection moved from standalone top-level sections into the Sessions section where they live in the app; Sessions section now clearly documents the five sub-tabs (Overview, Trace, Flow, Tools, Files) including that Insights lives inside Overview
- **Log file ingestion mentioned in descriptions** — Help Overview paragraph, VS Code extension description, and walkthrough "Agents Are Ready" step now surface log file ingestion as a zero-config data source alongside OTEL traces

---

## [0.4.0] — 2026-06-02

### Added

- **Source filter** — Sessions and Analytics tabs now have an OTEL / Log toggle to show only OpenTelemetry-traced sessions or only log-ingested sessions (or both)
- **Session initiator badges** — each session row shows a `User`, `Agent`, or `API` badge indicating how the session was started; an Initiator filter in the Sessions tab lets you narrow to a specific origin
- **Real-time log updates** — standalone server uses `fs.watch` to detect JSONL file changes and re-reads the full file immediately, so new turns appear without waiting for the 30-second poll

### Fixed

- **Standalone first-load blank page** — log sessions are now loaded synchronously before the first response so the Sessions tab is never empty on first open
- **Standalone cache hit rate and token counts** — corrected calculation from log-ingested sessions; total tokens and cache hit rate now match VS Code sidebar values
- **VS Code notification prefixes** — alert and automation notifications are now prefixed `Alert:` / `Automation:` instead of the longer `AgentLens Alert:` / `AgentLens Automation [label]:`
- **Reset button placement** — Reset sits adjacent to the Source filter in the Sessions and Analytics toolbars, with a slightly larger hit area

### Docs

- Getting Started reordered: Local (npx) install first, VS Code second, Docker third; "standalone" renamed to "local" throughout README and in-app Help

---

## [0.3.0] — 2026-06-02

### Added

- **Local log file ingestion** — AgentLens now reads JSONL session files from disk for all three agents automatically, with no OTLP setup required. Files are scanned at startup (newest-first, in batches of 10 to avoid blocking) and polled every 30 seconds for new or updated files. Sessions from log files carry an OTEL/Log source badge in the Sessions table.
  - Claude Code: `~/.claude/projects/**/*.jsonl` (env override: `CLAUDE_CONFIG_DIR`)
  - Codex: `~/.codex/sessions/**/*.jsonl` (env override: `CODEX_HOME`)
  - Copilot CLI: `~/.copilot/session-state/<uuid>/events.jsonl` (written automatically — no env setup required)
  - Disable via `agentLens.enableLogIngestion: false` in VS Code settings
- **Standalone server — log ingestion + npx** — the standalone server now ingests local log files, auto-opens the browser on start, and is available as `npx agentlens` / `npx agentlens-dashboard` (pass `--no-open` to suppress browser launch)
- **Cost table — M/K token display** — token counts in the Estimated Cost table now display in compact form (e.g. `1.2M` / `345K`) with a toggle to switch between compact and raw numbers; Model column shortened to show only the model name without the provider prefix

### Fixed

- **Analytics chart label overlap** — date and turn labels on all three charts now thin automatically to prevent collision at any zoom level or session count: `HistoryChart` (SVG bar chart, daily mode) uses a pixel-aware stride snapped to human-readable intervals; `CostBarChart` uses a minimum-gap guard on day boundary labels; `ContextGrowthChart` uses pixel-aware x-axis step calculation (minimum 32 px between label centres)
- **Copilot log path** — Copilot sessions now read from `~/.copilot/session-state/` (the path written by Copilot CLI automatically); was incorrectly reading from `~/.copilot/otel/`
- **In-progress vs. missing prompt** — sessions with a prompt that hasn't arrived yet show `…`; sessions that genuinely have no prompt (e.g. log-only Codex sessions) show `—`
- **Copilot prompt extraction** — startup log scan now skips injected XML preamble blocks (`<current_datetime>`, `<system_reminder>`) when extracting the user request from Copilot `transformedContent` events

### Docs

- README and walkthrough updated for log file ingestion; Docker and native run instructions added; OTEL setup prioritised over log files in getting-started guide
- ARCHITECTURE.md updated: new §4 Local Log Ingestion (file paths, incremental scan mechanics, data parity table), §1 system overview showing `LogReader` as a parallel ingestion path, updated `SessionSummaryCard` class diagram (`dataSource`, `conversationId`), and updated file map

---

## [0.2.1] — 2026-06-01

### Added

- **Analytics cost table — CSV download** — `↓ CSV` button above the Estimated Cost table exports `agentlens-cost.csv` with one row per agent per day (raw numeric token counts and 4-decimal cost) plus a grand total row; works in VS Code and standalone browser

### Fixed

- **Automation notifications** — all three notification sites now consistently read `AgentLens Automation [label]`; was showing `AgentLens [label]` (missing "Automation") or `AgentLens Automation: label` (colon instead of brackets)
- **Sidebar burn rate** — retains last known value after a session ends instead of reverting to "Waiting for data…"; resets when a new session starts
- **Standalone sidebar** — removed Open Dashboard button (the dashboard is the main panel in standalone; VS Code sidebar keeps it)
- **Sessions filter bar** — sort pills (Cost/Duration/Tokens) replaced with a Reset button at the right end; clears text filter, agent filter, time range, session limit, and sort back to defaults; only visible when at least one filter is non-default
- **Analytics** — Token Usage Per Session section moved below Context Growth
- Silent catch blocks in standalone server now log via `console.warn` instead of swallowing errors; unhandled promise on `writer.drain()` now has a `.catch()` handler; DB open failure logs the reason

## [0.2.0] — 2026-06-01

### Added

- **SQLite persistence** — four-phase database layer: schema (phase 1), write path persisting sessions after summarization (phase 2), read path replacing in-memory summarization with DB queries (phase 3), and analytics layer with historical queries, session search, time-range filtering, and storage management (phase 4)
- **Sidebar reworked as real-time live session monitor** — replaces the previous static summary with a live-updating panel: status card (Active/Idle, agent, model, prompt), counters (Turns / Tools / Errors / Cache hit rate), context growth sparkline with play/pause controls, token bars scaling independently against historical average with avg values inline, estimated cost card, and burn rate card; "X sessions stored" footer; Clear All Data fully resets all top-card fields
- **Sessions tab overhaul** — sortable by Cost, Duration, or Tokens via pills in the filter bar; filtered session count shown; Tools and Flow sub-tab labels show counts; expand-in-place row with five sub-tabs: Overview (stat tiles, burn rate, Insights), Trace (LLM and tool call waterfall), Flow (turn-to-tool graph), Tools (donut chart), Files (modified files with diffs)
- **Analytics tab overhaul** — per-agent breakdown cards, Estimated Cost chart with daily total green overlay line and date labels drawn inline at day boundaries, Token Usage Per Session, Context Growth chart with session-cycling animation
- **Standalone server sidebar parity** — token bars, estimated cost, burn rate, counters, sparkline, and all CSS classes now match the VS Code sidebar exactly; fixed crash from undefined `inProgressTraceIds` variables
- **Demo replay: export-format support** — `pnpm run demo -- --file ./export_sessions_<timestamp>.json` now works; converts session summaries into synthetic OTEL spans (root + LLM call + tool call spans per session) with correct attribute keys for the summarizer
- **Estimated cost per LLM span** — shown in Traces and Flow tabs alongside each LLM call
- **Tool call detail in Traces tab** — arguments and results visible in expanded span rows
- **Session ID in clipboard prompts** — Insights copy button includes `Session ID:` so AI can identify the session
- **user_input timeline entry type** — Claude Code permission prompt interactions captured in the session timeline
- **"X sessions stored" footer** — unfiltered session count shown in sidebar footer and Sessions tab footer
- **Date labels inside Estimated Cost chart** — day boundary labels rendered inline matching Token Usage Per Session style

### Fixed

- Standalone sidebar tokens and estimated cost not rendering — `computeSidebarPayload` was missing `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreateTokens`, `costUsd`, `avgInputTokens`, `avgOutputTokens`
- Context Growth animation frozen in play mode — `focusedSessionId` was overriding `activeIdx` unconditionally; animation index was resetting to 0 on every SSE update due to new array reference on each render
- Sidebar Clear All Data not resetting top card — agent name, duration, prompt, and model now clear when `currentSession` is null
- Sidebar active indicator firing on background Copilot calls — whitelisted to real agent span names only (`claude_code.*`, `invoke_agent*`, `codex.turn/session`); 45-second window
- Burn rate tied to `isActive` instead of 2-minute `startTime` cutoff
- Sidebar estimated cost: cache tokens subtracted from `inputTokens` before rate calculation (matches Sessions table)
- Help pill nav clipping on wrap — `flex-wrap:nowrap` + horizontal scroll
- Demo replay crash on export files — `BigInt()` cannot parse ISO timestamp strings
- Status bar item now opens both sidebar and dashboard on click

### Changed

- Daily total line on Estimated Cost chart changed from purple to green, matching cost value color used throughout the UI
- Summaries tab renamed to Traces; old waterfall Traces tab removed
- Tab structure simplified to 6 primary tabs: Sessions, Analytics, Alerts, Automation, Export, Help
- Automation popups labelled "AgentLens Automation: \<label\>"; alert popups labelled "AgentLens Alert"
- "Current session" label removed from sidebar status card
- Insight card text size reduced to 11px to match rest of UI
- Product name removed from all clipboard prompts
- Sessions sort moved into filter bar; Errors sort removed

### Docs

- README: updated tagline, corrected Claude Code config (removed stale `OTEL_SEMCONV_STABILITY_OPT_IN` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` env vars now cleaned up by auto-configure), dashboard tab names corrected, Copilot billing table updated
- Walkthrough files: dashboard tab table rewritten for current 6-tab structure; loops walkthrough updated to reflect Insights location and clipboard copy button
- Help tab Setup section: stale env vars removed; Copilot OTEL coverage corrected (cache read tokens are available; only cache write is absent)
- ARCHITECTURE.md: fully rewritten covering the 4-phase SQLite persistence architecture with Mermaid diagrams

## [0.1.5] — 2026-05-28

### Added

- **Claude Code cost estimates** — the Cost tab now includes `claude_code` sessions alongside Copilot and Codex; uses Anthropic API token-based pricing (input, cache write, cache read, output) with per-model rates for all current Opus, Sonnet, and Haiku variants; no billing mode toggle needed (Claude has always been token-based)
- **Codex cost estimates** — Cost tab extended to include Codex CLI sessions using OpenAI token-based pricing (input, cached input, output) with rates for all current and deprecated Codex models
- **Primary tab bar + More ▾ overflow dropdown** — replaces the flat wrapping tab row with a fixed-height single row; six primary tabs always visible (Efficiency, Cost, Summaries, Recommendations, Export, Help); ten secondary tabs (Agents, Alerts, Automation, Errors, Files, Flow, Latency, Tokens, Tools, Traces) in an alphabetically-sorted dropdown; active secondary tab name shown in the button label
- **Help tab — mode-aware Setup section** — configuration steps adapt to VS Code extension vs. standalone server context; Copilot CLI configuration added; Manual Configuration section with per-agent headings
- **Help tab — glossary hyperlinks** — first-mention of each glossary term in body text links to its definition; VS Code webview link styling fixed
- `pricing.ts` — Codex model rate table (all current and deprecated models including `codex-mini-latest`); Claude fast-mode rates corrected (`claude-opus-4-6-fast`, `claude-opus-4-7-fast` at $30/$150 per MTok); deprecated Claude models added for historical sessions
- `PRICING_SOURCES.md` — Claude section fully populated: source URL, OTEL fields, formula, rate table with fast-mode and deprecated entries, known gaps (cache TTL ambiguity, fast-mode underestimation, Opus 4.7 tokenizer change)

### Fixed

- Help tab VIEWS array: replaced stale `Timeline` entry (orphaned component, not a real tab) with `Export`; order corrected to match the actual tab bar sequence

### Changed

- Cost tab: Claude and Codex subtotal rows added to the session table footer; grand total row now appears when sessions from any two agent types are present; Known Gaps section restructured per-agent with a new Claude block
- Cost tab empty state updated to mention Copilot, Claude, and Codex
- Renamed "OpenAI Codex" → "Codex" throughout dashboard UI, Help tab, README, and configuration scripts
- README restructured: Getting Started moved before Features; Standalone Docker split into Running and Configuring subheaders; Cost Estimation section expanded to cover all three agents; Manual Configuration section expanded to mirror Help tab content; `chmod +x` and PowerShell execution policy instructions added for configuration scripts; Additional Features section added at the bottom

## [0.1.4] — 2026-05-27

### Added

- **Cost tab** — estimates Copilot session cost with three billing model toggles: token-based AI Credits (Jun 2026+, default), request-based with multipliers (pre-Jun 2026), and annual-plan request-based (post-Jun 2026 for annual plan holders)
- Per-session cost bar chart; zero-cost sessions shown as a colored tick on the x-axis
- Cross-session cost table with token breakdown, cost, and AI Credits columns; respects active session filter
- Estimates-only disclaimer with last-updated date and anchor-linked Known Gaps section
- `media/src/pricing.ts` — rate table for all Copilot models verified against GitHub pricing docs, including footnotes for included models (GPT-4.1, GPT-5 mini → $0 in token mode) and long-context surcharge notes
- `PRICING_SOURCES.md` — authoritative source URLs and maintainer notes for all three Copilot billing models

### Fixed

- README "Agent Telemetry Formats — Copilot" section incorrectly stated cache token data is unavailable; corrected to note cache read tokens are present via `gen_ai.usage.cache_read.input_tokens` and only cache write is absent

### Changed

- README: added Cost Estimation section, updated feature list, corrected dashboard tab count to 16

## [0.1.3] — 2026-05-24

### Changed

- README overhauled — restructured around a local/transparency theme; Getting Started split into VS Code Extension and Standalone (Docker) subsections with ephemeral and persistent Docker commands; Configuration reorganized with Manual Configuration first followed by Auto-configuration; Replaying Exported Spans promoted to its own top-level section; section headers simplified throughout
- Removed unused setting from VS Code extension settings contributions

## [0.1.2] — 2026-05-22

### Added

- **Export tab** — new dashboard tab (between Errors and Help) with Export Raw and Export Redacted buttons, 3-second confirmation state, and inline replay instructions
- **Export Redacted** — `AgentLens: Export OTEL Data (Redacted)` command; prompt text, tool inputs/results, and PII fields (`user.*`, `enduser.*`, `organization.*`) replaced with `[redacted]`; files named `export_redacted_*`
- **Replay from exported file** — `pnpm run demo -- --file <path>` replays any exported JSON (raw or redacted) directly into the dashboard; instant send by default, `--speed N` for paced replay; works with both plugin and standalone on port 4318
- **Sidebar latest session card** — model, source, turns, tool calls, errors, and cache hit rate for the most recent session
- **Sidebar expand/collapse** — ◄/► toggle to show or hide the AgentLens sidebar panel; dashboard opens automatically on first activation

### Changed

- Recommendations action buttons unified to "Copy for {Agent}" / "Copy to Clipboard" (removed "Ask Claude / Ask Copilot / Ask Codex" labels)
- Standalone export now downloads a ZIP archive; plugin export writes JSON files to workspace root

### Fixed

- Export `message` event listener was registered inside the tooltip `useEffect` without cleanup — moved to its own `useEffect` with proper removal on unmount

## [0.1.1] — 2026-05-22

### Fixed

- Port conflict detection now distinguishes between another AgentLens VS Code window (silent fallback with cross-window sync), the AgentLens standalone server (error with specific message), and an unrelated process (error with instruction to change `agentLens.otlpPort`)
- Plugin and standalone servers now expose fingerprint endpoints (`/agentlens/plugin` and `/agentlens/standalone`) so each can identify the other

## [0.1.0] — 2026-05-21

### Added

- Built-in OTLP/HTTP collector on `127.0.0.1:4318` — JSON-over-HTTP only (protobuf not required)
- Auto-configuration for GitHub Copilot, Claude Code, and Codex on activation
- 15-tab dashboard: Efficiency, Recommendations, Alerts, Automation, Summaries, Traces, Files, Agents, Tokens, Latency, Flow, Tools, Errors, Export, Help
- Loop and malfunction detection — Tool Call Deadlock, State Corruption Spiral, Hallucination Amplification Loop, Escalating Scope, Context Accumulation
- Conversation grouping — Copilot and Codex sessions linked by their conversation thread ID
- Per-session Conversation column in Efficiency tab
- Standalone web server mode (`pnpm run standalone`) and Docker image (`agentlens/agentlens`)
- Write Prompts File automation — writes triggered prompts to `agentlens-prompts-{agent}.md` in workspace or server directory
- Automation recency guard — only sessions active within the last 2 minutes trigger automations
- Per-agent threshold profiles for Alerts and Automation tabs
- Export tab — export raw or redacted span data as JSON directly from the dashboard; includes replay instructions
- Export OTEL Data command — writes raw span data as JSON files (Command Palette: `AgentLens: Export OTEL Data`)
- Export OTEL Data (Redacted) command — same export with prompt text, tool inputs/results, and PII fields replaced with `[redacted]` (Command Palette: `AgentLens: Export OTEL Data (Redacted)`)
- Collector error banner in sidebar when OTLP port is already in use
