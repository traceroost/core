# `src/cloud/` — why this is a separate directory (and a separate license)

If you're browsing the tree wondering why this exists outside the rest of
`src/`, this is the short answer. For the deep architecture, see
[CLOUD_ARCHITECTURE.md](../../CLOUD_ARCHITECTURE.md) and
[ARCHITECTURE.md §15](../../ARCHITECTURE.md#15-traceroost-pro--org-link). For
what shipped feature-by-feature, see CLOUD_ARCHITECTURE.md's "What ships
where" table.

## What's in here

```
src/cloud/
├── org/           the paid, networked half — OAuth link, credentials, the
│                  panel/CLI controller that turns a session close into a
│                  queued rollup
└── forward/       the wire format, the disk-backed queue, and the sender
                   that drains it to the hosted service — only while linked
```

Two mirrored directories carry the webview and CLI surfaces for the same
code: `media/src/cloud/panels/` (the Org panel) and `standalone/cloud/`
(`org`, `--explain-payload`, `cluster`, and the telemetry step of
`advise --apply`).

## Why this directory is only the cloud

Everything under `src/cloud/`, `media/src/cloud/` and `standalone/cloud/` is
TraceRoost Pro's linking and uploading — and nothing else. The free, local
features that used to sit beside it were moved out:

| Was | Now | What it is |
| --- | --- | --- |
| `src/cloud/attribution/` | `src/attribution/` | who wrote which surviving lines, from git history + session records, no network |
| `src/cloud/turnover/` | `src/turnover/` | the cohort/survival engine behind `traceroost cohort`, built on `attribution/`'s output |
| `standalone/cloud/{sessionLoader,traceCli,patternsCli,findCli,cohortCli,adviseCli}.ts` | `standalone/local/` | the local CLI analysis commands |

Where a local command has one optional cloud step — resolving a cloud
`repo_hash` back to a local clone for `find`/`patterns`/`cohort`, or queueing
an instruction-telemetry event after `advise --apply` — the local module takes
that step as a parameter (`standalone/local/repoResolve.ts`'s
`RepoHashResolver`, `adviseCli.ts`'s `AfterApplyHook`) and `standalone/cli.ts`
passes the cloud implementation in. Local code never imports from a `cloud/`
directory.

Everything else reaches these directories only through three seams —
`src/cloudBridge.ts` (implemented here by `bridge.ts`), `media/src/orgPanel.ts`
and `standalone/cliCloud.ts` (implemented by `standalone/cloud/cliBridge.ts`) —
each with an inert core stub beside it.

That makes the directory boundary mean one thing: **leave every `cloud/`
directory out and the free product still builds and works** — which is exactly
what the core edition does (`node esbuild.js --edition=core`; see
CONTRIBUTING.md → Editions). The directory is the
unit the core build leaves out, and the unit covered by the different license
below. The free/paid rule itself is unchanged — see
CLOUD_ARCHITECTURE.md's two rules; nothing local is gated behind Pro, and
`attribution/` and `turnover/` are free forever.

## The license split

This is the one directory in the repository **not** covered by the root
[MIT LICENSE](../../LICENSE). See [NOTICE.md](../../NOTICE.md) for the exact
scope and [LICENSE](LICENSE) here for the terms (Business Source License
1.1 — currently a draft pending legal review).

Why: everything else in this repository — the dashboard, the log readers,
the standalone server, the extension shell — is a local developer tool with
no plan to be sold as a hosted service by anyone, TraceRoost included.
`src/cloud/` is different: it's the client half of the one thing here that
*is* a commercial hosted product (the org/cloud service). Shipping the
client side under the same permissive MIT terms as the rest of the tool
would mean anyone could take this source, stand up the hosted half, and
compete with
that product on day one — which the free/local features can't be undercut
on (there's no hosted component to duplicate), but the org/cloud service
can. BSL's shape fits that specific risk: source stays visible and usable
for your own work (self-host it, build on it, run it as part of TraceRoost
itself), but re-hosting it commercially without
an agreement is what's fenced off — and it still converts to a normal open
license (Apache 2.0) after the Change Date, so the fence isn't permanent.

Practically, this has near-zero effect on anyone using TraceRoost normally:
the npm package and VSIX only ship a compiled bundle (`src/**` is excluded
from both via `.npmignore`/`.vscodeignore`), so the license split is a
statement about *this GitHub repository's source*, not about a restriction
end users of the product ever run into.
