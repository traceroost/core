# Runbooks

Recurring maintenance tasks in this repo — the kind that come up periodically, get done the same
way each time, and are easy to forget about between runs. This file is an index, not the
instructions themselves; each task's actual procedure lives in its own doc, linked below.

These are agent- or human-initiated on demand (e.g. "is pricing stale?"), not scheduled or
automated — there's no cron job or CI check that triggers them.

## Tasks

| Task | Trigger | Instructions |
| --- | --- | --- |
| Refresh model pricing | A vendor changes rates, adds/retires a model, or you notice cost estimates look off | [`PRICING_SOURCES.md`](../PRICING_SOURCES.md) |
| Cut a release | Someone asks for a release (e.g. "release these changes as X.Y.Z") | [`RELEASING.md`](RELEASING.md) |
| Switch releases from the core to the full edition | TraceRoost Cloud launches (releases are core — no org-link/upload code — until then) | [`RELEASING.md` → Editions](RELEASING.md#editions) |
| Calibrate loop/malfunction signals | The session corpus has grown since the last pass, or a signal's fire rate looks suspicious (fires on nearly everything, or never fires) | [`SIGNAL_CALIBRATION.md`](SIGNAL_CALIBRATION.md) |
| Validate Windows | Before a release: check the latest `E2E` run (`.github/workflows/windows-e2e.yml` — real VS Code, npm package, Task Scheduler service and configure scripts on Windows x64/ARM64), then do the short manual list (Copilot sign-in, visual pass, org link) | [`WINDOWS_VALIDATION.md`](WINDOWS_VALIDATION.md) |
| Look up repo traffic history | Someone asks how many views, visitors or clones the repo has had beyond GitHub's 14-day window | Read the CSVs on the `traffic-stats` branch (`views.csv`, `clones.csv` per UTC day; `referrers.csv`, `paths.csv` per weekly snapshot), written weekly by `.github/workflows/traffic.yml` — see [`CONTRIBUTING.md` → Continuous integration](../CONTRIBUTING.md#continuous-integration). An empty or stale branch usually means the `TRAFFIC_TOKEN` secret is missing or expired; check the workflow's last run |

## Adding a new runbook

1. Write the task's step-by-step procedure as a standalone doc. If it's tightly coupled to an
   existing root-level doc (like pricing is to `PRICING_SOURCES.md`), extend that doc instead of
   creating a new one. Otherwise, add a new file in this directory.
2. Include: what triggers the task, the exact steps in order, how to verify the change (which
   tests/lint/build commands to run before considering it done), and whether it needs its own
   dedicated branch/PR (default: yes — keep runbook-driven changes scoped to just that task, not
   bundled into unrelated work, same as the pricing refresh below).
3. Add a row to the table above.
