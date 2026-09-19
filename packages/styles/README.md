# @traceroost/styles

Shared CSS for TraceRoost's two UIs — the VS Code extension / standalone dashboard (this repo,
`media/src/`) and the web dashboard (`traceroost-cloud`, a separate repo). Published from here
because this repo is public; `traceroost-cloud` consumes it as an ordinary npm dependency.

## Why a package instead of copy-pasted files

The two UIs are built with different frameworks (Preact here, React over there) against
different design-token names (`--fg`/`--muted`/… here, `--c-ink`/`--c-muted`/… there), on
independent release schedules. A published package gives `traceroost-cloud` a version to pin and
bump deliberately, instead of a file that silently drifts or a copy someone forgot to update.

## How each file works

Every file here reads only its own small set of `--tr-*`-prefixed custom properties — never a
consumer's own design tokens directly. A consumer maps those few tokens **once**, to its own
theme, and every component built from that file then renders identically in both products. See
`src/pills.css`'s header comment for its specific token list and an example of what that mapping
looks like (`media/src/styles/base.css`'s `:root` here; `globals.css` in `traceroost-cloud`).

The one thing components still pass in themselves, inline, is an *identity* value that's
inherently per-instance — e.g. `pills.css`'s `--tr-pill-color`, an agent's brand color. Structure
(size, spacing, radius, the active/hover/disabled treatment) always stays in the shared file.

`agent-colors.css` is the one exception to "a consumer maps these to its own theme": its
`--tr-agent-*` tokens are fixed identity colors (core's `getAgentColor()` values), not structural
tokens, so a consumer's own alias for one (e.g. traceroost-cloud's `--agent-claude`) should point
at it with the same value in every theme rather than remapping it per light/dark.

## Adding a new shared file

1. Add `src/<name>.css`, following the pattern above: only `--tr-*` custom properties, documented
   in a header comment, plus whatever inline identity value (if any) a consumer supplies per
   instance.
2. Add it to `src/index.css`'s `@import` list.
3. Add an `exports` entry in `package.json` (mirror the `pills.css` one).
4. Document the token list in this README if it introduces new `--tr-*` names a consumer needs
   to map.

## Consuming this package

**traceroost/core** (this repo) imports the source files directly — no dependency needed, it's
the same repo:

```ts
import '../../packages/styles/src/pills.css'
```

**traceroost-cloud** depends on the published package and imports by subpath:

```css
@import '@traceroost/styles/pills.css';
/* or, for everything in this package at once: */
@import '@traceroost/styles/index.css';
```

## Releasing

Tag `styles-v<version>` (e.g. `styles-v0.1.1`) after bumping `version` here — a separate tag
prefix from the extension's own `v*` releases, so a CSS-only change doesn't force an extension
version bump or vice versa. `.github/workflows/release-styles.yml` publishes to npm via OIDC
Trusted Publishing, mirroring the main package's `publish-npm` job in `release.yml`.

The very first publish of a brand-new package name can't use Trusted Publishing yet — npmjs.com
needs the trust relationship configured against an *existing* package, or a first manual publish
to create it. See that workflow file's header comment for the one-time setup this needs before
the first `styles-v*` tag.
