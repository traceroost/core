# Withdraw a bad release

What to do when a published `vX.Y.Z` is broken. Publishing is effectively irreversible
([`RELEASING.md`](RELEASING.md), step 6): you cannot delete a version from npm after 72 hours, and
you can never publish the same version number twice anywhere. So the plan is always the same —
**stop new installs from picking up the bad version now, then ship a fixed `X.Y.(Z+1)`** — and the
only judgement is how much of the first half each channel needs.

**Trigger:** a released version crashes on start, loses data, breaks agent configuration, leaks
something it shouldn't, or fails to install on a platform.

## 0. Decide (5 minutes)

- **Data loss, a privacy leak, or a crash on start for most users** → do every step below now.
- **A bug in one feature** → skip to step 7 and ship the fix; the channels update on their own.

Write down the bad version and the last good one (`git tag --sort=-creatordate | head`).

## 1. GitHub release → back to the last good one

The desktop download links on traceroost.com (`src/lib/desktop-downloads.ts` in cloud) and the
README's "latest release" links all read `releases/latest`, which is the newest release that is
neither a draft nor a pre-release. Marking the bad one a pre-release moves "latest" back:

```bash
gh release edit vX.Y.Z --prerelease --repo traceroost/core
```

Add a line to the top of its notes saying it's withdrawn and which version to use. Don't delete
the release: its assets are what winget, Homebrew and existing download links point at, and a
404 is worse than an old build.

## 2. npm → move `latest` back, deprecate the bad version

```bash
npm dist-tag add traceroost@<last-good> latest
npm deprecate traceroost@X.Y.Z "Broken: <one line>. Use <last-good> or later."
```

`npx traceroost@latest` and the background service's update check both follow the `latest`
dist-tag, so this stops new installs and update prompts at once. Unpublishing is possible only
within 72 hours and only if nothing depends on it — prefer deprecate.

## 3. Docker → re-point the moving tags

The release pushed `X.Y.Z`, `X.Y`, `X` and `latest` to both `traceroost/traceroost` (Docker Hub)
and `ghcr.io/traceroost/core`. Point the moving ones back at the last good image (log in to both
registries first):

```bash
for img in traceroost/traceroost ghcr.io/traceroost/core; do
  docker buildx imagetools create -t $img:latest -t $img:X.Y -t $img:X $img:<last-good>
done
```

(If the bad release opened a new minor, `X.Y` points only at the bad version: leave it, or delete
that tag in the registry UI.) Leave `X.Y.Z` itself in place — someone may have pinned it.

## 4. Homebrew → revert the formula

The release committed `Formula/traceroost.rb` to `traceroost/homebrew-tap`. Revert that commit:

```bash
git clone https://github.com/traceroost/homebrew-tap && cd homebrew-tap
git revert <the "traceroost X.Y.Z" commit> && git push
```

`brew upgrade` then stays on, or returns to, the last good version.

## 5. VS Code Marketplace and Open VSX → ship the fix, never unpublish

There is no per-version withdrawal you should use: `vsce unpublish` removes the **whole**
`agentlens.agentlens-dashboard` listing, and every installed copy loses its update path. Installed
extensions update automatically, so the fastest remedy is the fixed version (step 7). If the fix
will take hours, publish the last good code as `X.Y.(Z+1)` first.

## 6. winget → close or supersede

If the `microsoft/winget-pkgs` pull request for `X.Y.Z` is still open, close it with a comment. If
it merged, the next release's PR supersedes it; there is no faster path.

## 7. Ship the fix

Follow [`RELEASING.md`](RELEASING.md) with the next patch version. A revert of the bad commit is a
fine fix. Once it's out and green on every channel, the `latest` tags above move forward on their
own (npm, Docker, Homebrew, GitHub release); remove the pre-release mark from `vX.Y.Z` only if you
want it listed again — usually leave it.

## 8. Tell people

- The release notes of `vX.Y.Z` (step 1) and of the fix: what broke, who was affected, what to do.
- If it touched TraceRoost Cloud data or linked machines, follow cloud's
  `runbooks/customer-comms.md`.
- `CHANGELOG.md`: the fix's entry says which version it replaces.

## Verify

- `npm view traceroost dist-tags` shows `latest: <last-good or fix>`.
- `docker buildx imagetools inspect traceroost/traceroost:latest` shows the good digest.
- traceroost.com's download strip names the good version (it revalidates hourly).
- `brew info traceroost/tap/traceroost` shows the good version.
