# Licensing notice

This repository is **not** entirely MIT-licensed. Two license zones apply:

| Path | License |
| --- | --- |
| Everything **except** the paths below | MIT — see [LICENSE](LICENSE) |
| `src/cloud/**`, `src/test/cloud/**`, `media/src/cloud/**`, `standalone/cloud/**` | Business Source License 1.1 — see [src/cloud/LICENSE](src/cloud/LICENSE) |

`src/cloud/` is the AgentLens/TraceRoost Pro (team, cloud) feature set — see
[CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) and
[src/cloud/README.md](src/cloud/README.md) for what it is and why it's split
out. The short version of the BSL grant: you can read it, self-host it, build
on it, and use it as a normal part of the TraceRoost product — including its
always-free, local-only features — for your own work. What it stops is
someone taking this source and standing up a competing hosted version of the
team/cloud service without a commercial agreement. Four years after
publication (or the stated Change Date, whichever is first) each version
converts to Apache License 2.0.

**Status:** the BSL text at `src/cloud/LICENSE` is a draft pending legal
review — see the banner at the top of that file. Treat this NOTICE as
describing the intended structure, not yet a finalized legal position.

This split exists because `src/cloud/` is the part of the codebase that could
plausibly be commercialized as a standalone hosted product; everything else —
the local dashboard, the free local Outcomes/attribution engine's *product
surface*, the standalone server, the VS Code extension shell — has no such
plan and stays MIT, matching the rest of the project.
