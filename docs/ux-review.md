# UX stability and Cloud alignment — September 16, 2026

Branch: `ux/core-review`, based on `cloud`. This follows Cloud's
`ux/cloud-review` branch from its own `main` repository.

## Findings and implementation

The baseline browser evaluation reproduced approximately 128px of trace-header
movement while filtering. Auto-sized columns changed with visible content, the
Project column depended on filtered results, and empty results removed the
entire table header. Filter selection also changed font weight; Reset, loading,
refresh, and pagination controls appeared and disappeared.

The trace table now uses explicit column widths, keeps headers in empty states,
and determines Project-column presence from the loaded dataset. Its scrollable
viewport keeps the footer in place as result counts change. Sort indicators
reserve space; headers use buttons with `aria-sort`; each trace has a keyboard
expansion button. Source cells include readable agent names alongside the badges.

Filters retain font weight and control footprints. Reset, refresh, status, and
paging slots remain present, with unavailable actions disabled. Project and
search fields have stable widths and accessible labels. Native scrolling is
available for navigation and wide toolbars on narrow screens. Scrollbar gutters
are reserved. Focus indicators and reduced-motion behavior are explicit.

Closed Settings and Team panels are hidden and inert: their offscreen shadows
no longer remain visible, and their controls leave the keyboard tab order.
Light-theme agent colors and badges align with Cloud's readable palette while
dark IDE colors remain available. Standalone cost figures use a darker green on
white. Core retains its compact IDE presentation and native theme integration.

## Repeatable Playwright evaluation

Run `pnpm test:ux`. It uses the existing Playwright dependency and browser;
on a new machine run `pnpm exec playwright install chromium` first.

The harness builds the actual dashboard entry point with esbuild, serves its
bundle and the standalone theme styles, and delivers 64 synthetic traces through
the dashboard's normal host-message boundary. It never starts log ingestion or
changes agent configuration. No developer trace history is read.

Desktop (1440×900) and mobile (390×844), in light and dark, exercise:

- Search, single-result and zero-result states, and restoration of the list.
- Ascending/descending token sorting, with semantic sort-state checks.
- Agent, data-source, initiator, project, and time-range filters.
- An asynchronous host update with much larger token counts.
- Keyboard expansion and collapse of a trace.
- Navigation through Traces, Analytics, Outcomes, Advisor, Export, and Import,
  with screenshots and JavaScript error checks.

Every animation frame measures stationary navigation, controls, headers, and
the pagination footer. Content coordinates account for intentional scrolling
to reach controls; reflow, resized controls, and removed anchors still fail.
The tolerance is one CSS pixel. Final evaluations recorded **zero pixels of
movement** and no removed anchors in all four profiles.

Results and screenshots are in `test-results/ux/`; CI runs the same command and
uploads that directory for 14 days. Screenshots support human review and are
not yet approved pixel-diff baselines. This is a dashboard integration harness,
not a test of the full VS Code host, live SSE transport, or production accounts.
Firefox, WebKit, screen-reader review, and exhaustive chart/panel interaction
coverage remain additional validation.

## Other checks

Type checks and production packaging pass. Lint reports warnings but no errors.
The existing unit suite has 550 passes and one pre-existing failure in
`forward/jsonSchemaValidate`: its missing-required-field test assumes
`repo_key_fp` is required, while the schema requires only `schema_version` at
the top level. The test, schema, and validator are byte-for-byte unchanged from
the base `cloud` branch; this UX change does not alter the ingestion contract.
