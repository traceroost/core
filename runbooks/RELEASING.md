# Releasing

Cutting a version release — bumping `package.json`, writing the `CHANGELOG.md` entry, and
publishing to the VS Code Marketplace, Open VSX, and npm.

**Trigger:** someone asks for a release (e.g. "release these changes as 0.10.1"). Not scheduled,
not automatic on every merge — a release can bundle just one merged PR or several that have
accumulated since the last one. Check what's landed since the last tag before assuming scope:
`git log <last-tag>..HEAD --oneline` (or `git tag --list | tail -5` to find the last tag).

## Two release lines

- **`main` — TraceRoost.** Publishes `traceroost.traceroost-dashboard` (VS Code Marketplace +
  Open VSX), `traceroost-dashboard` (npm), and `traceroost/traceroost` (Docker Hub). This is the
  active line.
- **`agentlens` branch — AgentLens (frozen).** Still publishes `agentlens.agentlens-dashboard` /
  `agentlens-dashboard` / `agentlens/agentlens` for critical fixes only. Cut those releases from
  the `agentlens` branch with the same steps below; nothing there needs re-provisioning.

**Before the first TraceRoost release from `main`, these must exist for the `traceroost` identity
(one-time, done by the account owner — the workflow itself needs no change):**

- npm package `traceroost-dashboard` with a **Trusted Publisher** pointing at `traceroost/core` +
  workflow `release.yml` (see `npm-trusted-publisher-rebrand` — the config takes a few minutes to
  propagate).
- VS Code Marketplace publisher `traceroost`, with `VSCE_PAT` updated to a token for it.
- Open VSX namespace `traceroost`, with `OVSX_PAT` updated.
- Docker Hub repo `traceroost/traceroost`, with `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` updated.

Until all four are in place, do the `main` commit + changelog but **do not push the tag** — the
publish jobs will fail partway and leave the release half-done.

## Steps

1. `git checkout main && git pull` — confirm a clean working tree and that everything you intend
   to release has actually merged.

2. Pick the version number. This repo is pre-1.0 and doesn't follow semver strictly — it's a
   judgment call on significance, not a mechanical rule:
   - **Patch** (`0.10.0` → `0.10.1`): bug fixes, small tweaks, even minor additions (e.g. a couple
     of new pricing table entries) when nothing shipped that's meaningfully new-feature-shaped.
   - **Minor** (`0.9.x` → `0.10.0`): one or more genuinely new user-facing features.
   - **Major**: reserved, hasn't happened yet in this repo's history.
   - Having an `### Added` section in the changelog entry doesn't automatically mean minor — v0.9.3
     had both `### Fixed` and `### Added` and was still a patch release. Weigh what a user reading
     the changelog would consider significant, not which headings are present.
   - **State your pick and the reasoning before writing anything** — "this looks like a patch bump
     (0.10.0 → 0.10.1), since it's one bug fix plus internal tooling, nothing new-feature-shaped" —
     and let the user correct it before you commit to a version number the changelog entry, commit
     message, and tag will all repeat several times over.

3. Write the `CHANGELOG.md` entry — insert it directly under the `All notable changes...` line, above
   the previous latest entry (newest-first), separated from the entry below it by a `---` line (every
   version section in this file has one — easy to forget when inserting at the top, since there isn't
   one *above* the newest entry to copy from by pattern-matching what's directly below).
   - Heading: `## [X.Y.Z] — YYYY-MM-DD` (today's date).
   - Subsections in this order, whichever apply: `### Added`, `### Fixed`, `### Changed`.
   - Each bullet: **bold lead-in naming the thing**, then a sentence or two of concrete detail (what
     broke and why, or what it does — not just a category label), ending with the relevant PR
     number(s) in parens: `(#192)`, or `(#176, #182, #189, #190)` if several PRs contributed to one
     bullet.
   - Scope it to what a user deciding whether to update would care about — this is a product
     changelog, not a commit log. A real product bug fix belongs in `### Fixed` with full detail,
     even if you found it incidentally while doing unrelated work (this has happened — a demo-data
     verification pass surfaced a real bug in `src/summarizers/codex.ts`, and that fix was the
     headline item of a release). Internal/dev-only tooling changes (e.g. demo script work, CI
     tweaks) get at most one brief `### Changed` bullet noting "no user-facing product change" —
     not an exhaustive rundown of every commit.

4. Bump `"version"` in `package.json`. As of writing this is the *only* file that tracks the
   version — `pnpm-lock.yaml` doesn't carry a root package version field, and there's no separate
   `standalone/`/`media/` package.json. Grep to confirm this is still true before assuming it:
   `grep -rn "\"version\": \"<old-version>\"" --include=package.json .`

5. Commit directly to `main` — release commits in this repo are the one established exception to
   the normal "always branch + PR" workflow used for everything else. `main` has branch protection
   requiring PRs; pushing anyway will succeed with a `Bypassed rule violations` warning if your
   account has bypass permissions, which is expected here, not an error to work around.

   ```bash
   git add CHANGELOG.md package.json
   git commit -m "chore: release vX.Y.Z — changelog and version bump"
   git push origin main
   ```

6. **Confirm with the user before pushing the tag.** `.github/workflows/release.yml` triggers on
   `push` of a `v*` tag, and is what builds the VSIX, creates the GitHub Release, and publishes to
   the VS Code Marketplace, Open VSX, and npm (via OIDC trusted publishing) — a public, essentially
   irreversible action once it lands (npm doesn't allow unpublishing after the fact in the general
   case). The commit from step 5 landing on `main` does **not** publish anything by itself — that
   part alone is safe and doesn't need a separate confirmation. Ask explicitly before the tag push,
   e.g. "push the vX.Y.Z tag now to trigger the actual publish (npm, VS Code Marketplace, Open
   VSX)?" — don't fold this into the same confirmation as the version-number pick in step 2, since
   the user may want to review the drafted changelog entry and commit before green-lighting the
   irreversible part.

   Once confirmed, tag the release commit and push the tag. Skipping this step silently leaves the
   release half-done — version bumped and documented, but nothing actually shipped anywhere. Past
   tags are lightweight, not annotated — match that:

   ```bash
   git tag vX.Y.Z <release-commit-sha>
   git push origin vX.Y.Z
   ```

7. Verify the workflow picked it up and is running: `gh run list --workflow=release.yml --limit 3`.
   No need to wait for it to finish before considering the release "done" from your end — it runs
   lint, typecheck, and the full unit suite before packaging, so a red run there means something
   real broke, not a rerun-and-hope situation.

## Verifying afterward

- `gh release view vX.Y.Z` — GitHub Release exists with the VSIX attached.
- `gh run list --workflow=release.yml --limit 1` — shows `completed` / `success`.
- If the marketplace/npm publish steps matter for this release (they usually do), spot-check
  `publish-vsce` and `publish-npm` job logs specifically — `package` succeeding only means the VSIX
  built, not that it published anywhere.
