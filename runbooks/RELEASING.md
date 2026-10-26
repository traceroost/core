# Releasing

Cutting a version release — bumping `package.json`, writing the `CHANGELOG.md` entry, and
publishing to the VS Code Marketplace, Open VSX, and npm.

**Trigger:** someone asks for a release (e.g. "release these changes as 0.10.1"). Not scheduled,
not automatic on every merge — a release can bundle just one merged PR or several that have
accumulated since the last one. Check what's landed since the last tag before assuming scope:
`git log <last-tag>..HEAD --oneline` (or `git tag --list | tail -5` to find the last tag).

## What one tag push publishes

| Artifact | Identity | Where the identity comes from | Secrets |
| --- | --- | --- | --- |
| npm | `traceroost` | `package.json` `name` | none (OIDC trusted publishing) |
| Docker | `traceroost/traceroost` + `ghcr.io/traceroost/core` | `docker.yml`, called by `release.yml`'s `docker` job | `TR_DOCKERHUB_USERNAME` / `TR_DOCKERHUB_TOKEN` (Docker Hub); `GITHUB_TOKEN` (ghcr) |
| Homebrew | `traceroost/tap/traceroost` (formula `Formula/traceroost.rb` in `traceroost/homebrew-tap`) | `release.yml`'s `publish-homebrew` job, after `publish-npm`: `scripts/homebrew-formula.mjs` writes the formula from the tarball npm serves | `HOMEBREW_TAP_TOKEN` (the job is skipped, with a notice, until it exists) |
| winget | `TraceRoost.TraceRoost` (manifests under `manifests/t/TraceRoost/TraceRoost/` in `microsoft/winget-pkgs`) | `release.yml`'s `publish-winget` job, after `desktop`: `desktop/scripts/winget-manifests.mjs` writes the manifests from the Windows installers the release serves, and `wingetcreate submit` opens the pull request; winget-pkgs moderators merge it | `WINGET_CREATE_GITHUB_TOKEN` (the job is skipped, with a notice, until it exists) |
| VS Code Marketplace + Open VSX | **`agentlens.agentlens-dashboard`** | `vsce-identity.json` — the `package` job patches `name`/`publisher` into `package.json` for the VSIX build only | `VSCE_PAT` / `OVSX_PAT` (the existing AgentLens publisher tokens) |

**Why the extension keeps the old id:** the marketplace id is sticky infrastructure users never
re-type; the displayName is already "TraceRoost". Keeping `agentlens.agentlens-dashboard` means
every installed AgentLens extension updates in place — no reinstall, no "both installed" conflict.
`package.json` still carries the npm identity (`traceroost`); the two are decoupled via
`vsce-identity.json`.

### One-time provisioning

| Target | Set up |
| --- | --- |
| npm `traceroost` | npmjs.com → package `traceroost` → Settings → Trusted Publisher: GitHub Actions, repository `traceroost/core`, workflow `release.yml` (takes a few minutes to propagate) |
| Docker Hub `traceroost/traceroost` | create the repo under the `traceroost` account; add `TR_DOCKERHUB_USERNAME` / `TR_DOCKERHUB_TOKEN` repo secrets |
| VS Code / Open VSX | nothing new — `VSCE_PAT` / `OVSX_PAT` already exist for publisher `agentlens` |
| Homebrew tap | create the public repo `traceroost/homebrew-tap` (the `homebrew-` prefix is what makes `brew install traceroost/tap/traceroost` work) with an empty `Formula/` directory; add a fine-grained token with **Contents: read and write on that repo only** as this repo's `HOMEBREW_TAP_TOKEN` secret. To seed it before the next release: `node scripts/homebrew-formula.mjs <current version> --out Formula/traceroost.rb` in the tap checkout, commit, push |
| winget | a **classic** token with only the `public_repo` scope, from the GitHub user who opens the pull requests (currently the maintainer's personal account; a bot account with no access to the traceroost org is safer once there are collaborators), as this repo's `WINGET_CREATE_GITHUB_TOKEN` secret — set 2026-10-23; renew it before it expires. wingetcreate uses (and creates, if missing) the fork `<token owner>/winget-pkgs` and syncs it with upstream before each submission; an organization fork such as `traceroost/winget-pkgs` is never used. The first pull request is reviewed by a moderator; later ones mostly merge automatically once validation passes. See [winget](#winget) |

`TR_VSCE_PAT` / `TR_OVSX_PAT` are **not used** right now. They exist for the eventual extension
cutover (below).

Until npm's trusted publisher and the Docker Hub repo exist, do the `main` commit + changelog but
**do not push the tag** — those publish jobs fail and leave the release half-done.

## Editions

Every release ships one edition — **core** (no TraceRoost Cloud / org-link / upload code at all) or
**full** (with it). See CONTRIBUTING.md → Editions for how the split works in the source.

**Currently: `core`.** Until TraceRoost Cloud launches, the VSIX, the npm package and the Docker
image are all built with `--edition=core`.

How a release picks its edition:

- a `v*` tag push uses the repository variable `TRACEROOST_RELEASE_EDITION`, and `core` when it
  isn't set — `release.yml` applies this rule and passes the result to `docker.yml`;
- a manual **Run workflow** (workflow_dispatch) uses its `edition` input (default `core`). A manual
  `release.yml` run only builds the VSIX as an artifact — publishing happens only from a tag. A
  manual `docker.yml` run builds and pushes a `sha-…`-tagged image only (never a version tag or
  `:latest`).

**Docker is gated on the release.** `docker.yml` has no tag trigger of its own: the tag runs
`release.yml`, whose `docker` job calls `docker.yml` (a reusable workflow) only after `package` has
passed — and `package` itself waits on `privacy-scan`. A tag whose lint, type check, unit tests,
privacy scan or edition check fails therefore publishes no image and leaves `:latest` alone. The
Docker push runs alongside `publish-vsce` / `publish-npm`, not after them.

What the `core` release does differently:

1. `node scripts/prepare-edition.mjs core` rewrites `package.json` for packing: drops the
   `traceRoost.org*` commands, removes the cloud directories' `LICENSE` files from `files`, appends
   `**/cloud/**` to `.vscodeignore`, removes every `### TraceRoost Cloud (full edition only)`
   section from `CHANGELOG.md` (the VSIX and the npm package both ship it), and points
   `vscode:prepublish` / `prepublishOnly` at `pnpm run package:core`.
2. `vsce package` / `npm publish` therefore run `package:core` — type check, lint,
   `node esbuild.js --production --edition=core`, and `scripts/check-edition.mjs core`, which fails
   the release if any Cloud marker is in a bundle, the manifest still lists an Org command, or
   `CHANGELOG.md` still has a cloud-only section.
3. The Docker image is built with `--build-arg EDITION=core` (the Dockerfile's default) and runs the
   same bundle check inside the build.

To check a core package locally before tagging:

```bash
node scripts/prepare-edition.mjs core
pnpm run package:core
npm pack --dry-run --ignore-scripts        # no cloud/ paths in the list
node scripts/prepare-edition.mjs restore   # always restore — never commit the rewritten package.json
```

**Flipping to `full` at launch:** set the repository variable `TRACEROOST_RELEASE_EDITION=full`
(Settings → Secrets and variables → Actions → Variables) — `release.yml` reads it and passes it on
to `docker.yml`; nothing else changes. For a permanent switch, change the `'core'` fallback in
`release.yml` (its `EDITION:` line and the `docker` job's `with: edition:`) and the Dockerfile's
`ARG EDITION=core` default to `full`, and
update "Currently" above and README → Editions. Before the first full release, run
`release.yml` manually with `edition: full` and install the VSIX artifact to check the Org panel.

## The `agentlens` branch

Cut from `main` @ v0.15.4. Its `release.yml` publishes **only** the frozen `agentlens-dashboard`
npm package and `agentlens/agentlens` Docker image (via the unprefixed `DOCKERHUB_*` secrets and
its own OIDC trusted publisher) — the `publish-vsce` job is removed, since `main` publishes the
`agentlens.agentlens-dashboard` extension listing.

Intended use: **one final release** — bump its version (e.g. `0.15.5`), add a CHANGELOG entry and
an in-app / `npm deprecate` "AgentLens is now TraceRoost — switch to `traceroost` / `traceroost/traceroost`"
notice, tag it, then leave the branch dormant. Not for ongoing work.

## Future one-time task: extension id cutover

When the TraceRoost brand is established and you want the marketplace URL to say `traceroost` too:

1. Create VS Code Marketplace publisher `traceroost` + claim Open VSX namespace `traceroost`; add
   `TR_VSCE_PAT` / `TR_OVSX_PAT` repo secrets.
2. Restore `publish-vsce` to a two-identity matrix (git history has it) — leg `agentlens` +
   leg `traceroost`, each gated on its PAT.
3. Before that release, rework `handleDuplicateInstall` in `extension.ts`: until now it treats
   `agentlens.agentlens-dashboard` as the one published listing to keep and `traceroost.traceroost`
   as an unpublished local build that stands down. Once both are published, the new listing should
   win and the old one stand down and point users at it (and `.vscode/launch.json`'s
   `--disable-extension` should name the right id).
4. Cut one release: it publishes `traceroost.traceroost` alongside `agentlens.agentlens-dashboard`.
5. In the marketplace publisher portal, mark `agentlens.agentlens-dashboard` **deprecated** with
   `traceroost.traceroost` as the replacement — VS Code then shows every user of it a
   "publisher recommends TraceRoost — Install" prompt.
6. After the population moves, stop publishing to `agentlens.agentlens-dashboard` (drop the matrix
   leg); the deprecated listing stays up as a redirect. Keep `handleDuplicateInstall` in
   `extension.ts` for the transition window.

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

3. Write the `CHANGELOG.md` entry. PRs merged since the last release have already added their
   bullets under `## [Unreleased]` (CONTRIBUTING.md asks for that); turn that section into the
   release entry — rename its heading, check every merge since the last tag has a bullet
   (`git log --first-parent --oneline v<prev>..HEAD`), tidy the wording — and start a fresh, empty
   `## [Unreleased]` above it. The entry sits directly under the `All notable changes...` line, above
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
   `release.yml` (and `docker.yml`, which it calls) refuses a `vX.Y.Z` tag that doesn't equal this
   version, so a forgotten bump fails the release instead of publishing (or pushing Docker
   `:latest`) under the wrong number.

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
   the VS Code Marketplace, Open VSX, npm (via OIDC trusted publishing) and Docker Hub / ghcr (its
   `docker` job) — a public, essentially
   irreversible action once it lands (npm doesn't allow unpublishing after the fact in the general
   case). The commit from step 5 landing on `main` does **not** publish anything by itself — that
   part alone is safe and doesn't need a separate confirmation. Ask explicitly before the tag push,
   e.g. "push the vX.Y.Z tag now to trigger the actual publish (npm, Docker, VS Code Marketplace, Open
   VSX) as the core edition?" — say which edition it ships (see [Editions](#editions)), since
   that's the one thing the tag doesn't show — don't fold this into the same confirmation as the version-number pick in step 2, since
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
- `gh run list --workflow=release.yml --limit 1` — shows `completed` / `success`, and the
  `package` job's "Check the … edition bundles" step names the edition you meant to ship.
- If the marketplace/npm publish steps matter for this release (they usually do), spot-check
  `publish-vsce`, `publish-npm`, `publish-homebrew` and `docker` job logs specifically — `package` succeeding only means the VSIX
  built, not that it published anywhere.

## Homebrew

`brew install traceroost/tap/traceroost` installs the same npm tarball, with Homebrew's `node`.
After that, everything works as it does for an npm install, through `traceroost` on the PATH:
`traceroost service install` writes the same launchd / systemd service, and `service install` /
`service update` upgrade with `brew upgrade traceroost` instead of `npm install -g`
(`standalone/service/homebrew.ts`). The service points at Homebrew's version-less `opt` paths
(`<prefix>/opt/traceroost/…`, `<prefix>/opt/node/bin/node`), so a `brew upgrade` never leaves it
naming a deleted keg. The formula has no `service do` block on purpose: `brew services` would be a
second manager running a second copy on the same ports.

**Try a change with Homebrew before releasing it** (on a Mac or Linux box with Homebrew, from a
checkout of the branch): `scripts/homebrew-local.sh`. It builds the core edition exactly as `npm
publish` would, packs it, writes a formula for that tarball (`homebrew-formula.mjs --tarball`)
into a local tap, `traceroost/local`, and installs it in place of any Homebrew copy. Then
`brew test traceroost/local/traceroost` and `traceroost service install`. Back to the published
formula: `brew uninstall traceroost && brew untap traceroost/local && brew install
traceroost/tap/traceroost`.

## winget

`winget install TraceRoost.TraceRoost` installs the desktop app's per-user NSIS installer (x64 or
arm64) from the GitHub release: `TraceRoost-<v>-win-<arch>.exe`, signed or not (an older release's
`*-preview.exe` is still recognised). `winget upgrade` updates it, including a copy installed from a downloaded
.exe, because the manifest names the installer's uninstall key (`ProductCode`). Unsigned installers
are accepted; winget checks every download against the sha256 in the manifest.

Each `v*` tag's `publish-winget` job writes the three manifests
(`desktop/scripts/winget-manifests.mjs`, hashing the installers it downloads from the release) and
opens a pull request on microsoft/winget-pkgs with `wingetcreate submit`. The package appears in
`winget search traceroost` once that pull request merges — usually within a day or two, longer for
the first one.

**Try the manifests before a release** (on Windows): download a release's installers, write the
manifests and install from them locally, without the public repository:

```powershell
gh release download v<v> -R traceroost/core --pattern 'TraceRoost-*-win-*.exe' --dir winget-assets
$dir = node desktop/scripts/winget-manifests.mjs --version <v> --assets winget-assets --out winget
winget settings --enable LocalManifestFiles   # once, from an administrator prompt
winget validate --manifest $dir
winget install --manifest $dir
```

**First submission by hand** (instead of waiting for the next tag): the same two first lines, then
`wingetcreate submit --token <classic token> $dir`.

## Desktop app

The desktop app under `desktop/` (see `desktop/README.md`) ships the same core-edition collector
the npm tarball does, built from the same tree, so its version is `package.json`'s version
automatically; a release bump needs no change in `desktop/`.

The tag's `release.yml` run includes a `desktop` job (`.github/workflows/desktop-release.yml`)
after `package`. It runs the macOS, Linux and Windows desktop workflows (the same builds every
desktop pull request runs, smoke tests, the Linux install matrix and the Windows install/upgrade/
uninstall check included), then attaches the installers, a
`TraceRoost-desktop-<v>-SHA256SUMS` and provenance attestations to the release `package` created. It
finishes well after the other publish jobs (the Linux distro matrix dominates), and a failure there
does not affect the VSIX, npm or Docker publish. Re-running a failed desktop job is safe: files
already attached are compared, never replaced, and only missing ones are uploaded.

Afterwards: `gh release view vX.Y.Z` lists the desktop files; download one and run
`sha256sum -c TraceRoost-desktop-X.Y.Z-SHA256SUMS --ignore-missing` and
`gh attestation verify <file> --repo traceroost/core`.

- **Linux** (.deb and AppImage, x64 and arm64) is attached on every release.
- **macOS is built, tested and attached on every release.** It is ad-hoc signed (not notarized)
  until the Apple Developer Program credentials exist, so Gatekeeper refuses the first open of a
  download until the user right-clicks → Open (the release notes say so). Once the secrets are in place (`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, plus
  either `APPLE_API_KEY_P8`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` or
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` — [`MACOS_SIGNING.md`](MACOS_SIGNING.md)),
  the same build is signed and notarized with no code change from the next tag on. Before
  announcing it as an install method, open a downloaded, quarantined DMG on a fresh macOS user
  account.
- **Windows** (NSIS installer and portable zip, x64 and arm64) is built, tested and attached on
  every release, Authenticode-signed when the secrets below exist and unsigned otherwise. Signing switches on from secrets, with no code change:
  either a code-signing certificate (`WIN_CSC_LINK` = base64 .pfx, `WIN_CSC_KEY_PASSWORD`) or Azure
  Artifact Signing (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: a service principal
  with the *Artifact Signing Certificate Profile Signer* role; the account `TraceRoost`, profile
  `traceroost-public` and publisher `Roger Reed` are in `desktop/electron-builder.cjs`, not
  secrets). The client secret expires (24 months at most): renew it before then, or Windows
  releases fall back to unsigned builds. `desktop-windows.yml` documents them and fails a configured
  build whose executables are not validly signed. `release.yml` passes each by name.
- **Unsigned builds**: until the signing secrets exist, a macOS build that is not notarized
  (ad-hoc signed) and a Windows build that is not signed are attached under the same plain names
  as signed ones (`TraceRoost-<v>-mac-<arch>.dmg`, `TraceRoost-<v>-win-<arch>.exe`), covered by the
  same SHA256SUMS and attestations, and the release notes get a section on getting past
  Gatekeeper (right-click → Open) and SmartScreen (More info → Run anyway)
  (`desktop-release.yml`'s "Note unsigned downloads" step). Once a platform's secrets exist, its
  build is signed with no other change. (0.20.0 named these `*-preview` instead.)
- **Switches**: the repository variable `TRACEROOST_DESKTOP_PLATFORMS` (default
  `linux,macos,windows`) turns a platform off without a code change; a non-`core`
  `TRACEROOST_RELEASE_EDITION` skips desktop with a notice (the app is core-only).
- **minisign**: with `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` set, the checksums file gets a
  `.minisig`. No key exists yet; publish the public key in `desktop/README.md` when one is made.

