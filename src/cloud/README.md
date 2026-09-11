# `src/cloud/` — why this is a separate directory (and a separate license)

If you're browsing the tree wondering why this exists outside the rest of
`src/`, this is the short answer. For the deep architecture, see
[CLOUD_ARCHITECTURE.md](../../CLOUD_ARCHITECTURE.md) and
[ARCHITECTURE.md §15](../../ARCHITECTURE.md#15-agentlens-pro--team-link). For
what shipped feature-by-feature, see [CLOUD_FEATURES.md](../../CLOUD_FEATURES.md).

## What's in here

```
src/cloud/
├── team/          the paid, networked half — OAuth link, credentials, the
│                  panel/CLI controller that turns a session close into a
│                  queued rollup
├── forward/       the wire format, the disk-backed queue, and the sender
│                  that drains it to the hosted service — only while linked
├── attribution/   free, local-only — who wrote which surviving lines,
│                  from git history + session records, no network
└── turnover/      free, local-only — the cohort/survival engine behind the
                   Outcomes tab, built on attribution/'s output
```

Two mirrored directories carry the webview and CLI surfaces for the same
code: `media/src/cloud/panels/` + `media/src/cloud/tabs/`, and
`standalone/cloud/`.

## Why one directory for two different things

`team/`+`forward/` and `attribution/`+`turnover/` sit on opposite sides of
the free/paid line — see the two rules in CLOUD_ARCHITECTURE.md. They're
grouped here anyway, because the axis this directory answers to isn't
pricing, it's **provenance and disposition**: everything in `src/cloud/` was
built as one connected effort (the `pro/01`–`pro/09` series, against the
closed-source `alsaas` service), ships as one thing, and is the part of this
codebase that could be spun out or licensed differently from the rest.
Pricing tier is a property of a *feature*, documented per-feature in
CLOUD_ARCHITECTURE.md's "what ships where" table — not a property of this
directory boundary. Don't infer "under `src/cloud/`" to mean "behind a
paywall"; `attribution/` and `turnover/` are free forever and always will be,
per the free/paid rule linked above.

## The license split

This is the one directory in the repository **not** covered by the root
[MIT LICENSE](../../LICENSE). See [NOTICE.md](../../NOTICE.md) for the exact
scope and [LICENSE](LICENSE) here for the terms (Business Source License
1.1 — currently a draft pending legal review).

Why: everything else in this repository — the dashboard, the log readers,
the standalone server, the extension shell — is a local developer tool with
no plan to be sold as a hosted service by anyone, TraceRoost included.
`src/cloud/` is different: it's the client half of the one thing here that
*is* a commercial hosted product (the team/cloud service), and its
counterpart lives in a closed-source repo already. Shipping the client side
under the same permissive MIT terms as the rest of the tool would mean
anyone could take this source, stand up the hosted half, and compete with
that product on day one — which the free/local features can't be undercut
on (there's no hosted component to duplicate), but the team/cloud service
can. BSL's shape fits that specific risk: source stays visible and usable
for your own work (self-host it, build on it, run it as part of TraceRoost
itself, including its free features), but re-hosting it commercially without
an agreement is what's fenced off — and it still converts to a normal open
license (Apache 2.0) after the Change Date, so the fence isn't permanent.

Practically, this has near-zero effect on anyone using TraceRoost normally:
the npm package and VSIX only ship a compiled bundle (`src/**` is excluded
from both via `.npmignore`/`.vscodeignore`), so the license split is a
statement about *this GitHub repository's source*, not about a restriction
end users of the product ever run into.
