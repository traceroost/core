# 01 — Pro panel and team link

**Phase 1 — identity and access.** First plan in this repo, and the first thing a
developer ever touches. Everything else here is invisible until this exists.

**Goal:** one place in the AgentLens client for everything Pro — join a team,
see what is being sent, check status, leave — reached from a new icon in the top
right, and doing nothing at all until someone opts in.

**Tier:** the panel ships to everyone; every capability inside it is Pro and
inert until a team is linked.

**Depends on:** SA 03 (the authorization server) for the link handshake. The
panel itself and its unlinked state can be built before that exists.

**Status:** staged, not filed.

**Related:** `src/dashboardPanel.ts`; `media/src/App.tsx` (the `ConfigPanel`
slide-in and the bell/gear icon row this sits beside); `src/serviceConfig.ts`
(`ensureAuthToken` — the credential pattern to follow); `ARCHITECTURE.md` §10.

---

## The surface

A new icon in the tab bar's right-hand icon group, beside the bell, gear and
help buttons, opening a slide-in **Team** panel — the same `ConfigPanel`
mechanism the settings drawer already uses, not a new window and not a modal.

Two states, and the unlinked one is the one to design first because it is what
almost every install shows forever.

**Unlinked.** States plainly that AgentLens is working exactly as it does now
and that nothing is being sent anywhere. Then: what a team link would send, what
it would never send, who would see it, and a single **Link this machine** button.
`Show the exact payload` runs `--explain-payload` against a real recent session
and prints it right there — before joining, not after. That ordering is the whole
argument.

**Linked.** Org name, the member's own identity and role, last successful
rollup, queue depth, client version. The current per-developer-visibility state
for that org, stated as a fact the developer can read without asking anyone.
`Show the exact payload`, still. `Open team view`. **Leave team**, at the same
visual weight as everything else — not hidden behind a confirmation maze.

## Why the icon and not a settings row

A developer who is being asked to send telemetry about their work to their
manager's dashboard should be able to find out what is happening in one click,
from anywhere in the product, without hunting. Burying it in a settings drawer
alongside port numbers says it is a configuration detail. It is not; it is the
thing most likely to make someone uninstall, and it earns its own affordance.

The icon carries a small state dot — grey unlinked, green reporting, amber
queued or degraded — so the answer to "is my machine sending anything right
now" is visible without opening anything.

## Linking

OAuth 2.0 Authorization Code with PKCE over a one-shot loopback callback. A
pasted team token is the obvious shortcut and is worse on every axis: a
long-lived secret in a config file and a shell history, leakable in a screenshot
or a support thread, unscoped and unrevocable server-side. PKCE is one keystroke
and one browser click — the part that decides whether anyone completes it.

1. Generate `code_verifier`, `code_challenge`, CSRF `state`.
2. Temporary HTTP server on `127.0.0.1:0` — a random port.
3. Browser to the authorize endpoint with the challenge and state.
4. Receive the redirect; verify `state`.
5. `POST` code + verifier to `/oauth/token`; receive tokens and `member_id`.
   No key material is exchanged.
6. Store in the OS keychain, file fallback.

Four details worth taking rather than rediscovering: bind `127.0.0.1` not
`localhost`, which avoids DNS resolution failures; respond to the browser
*before* resolving the promise, or the tab hangs; never hardcode the callback
port; always keep the file fallback, because keychains are absent in containers.

Device authorization grant (RFC 8628) ships as the documented fallback for
devcontainers, CI and headless boxes — not the default, because it trades a
redirect for typing a code and polling.

## Leaving

`agentlens team leave`, and the button in the panel, revoke server-side, delete
the local credential, and stop forwarding immediately — without waiting
for a server response, in case the machine is offline when the developer
decides.

This is a design requirement, not a courtesy. Telemetry about a developer's work
arriving on a manager's dashboard is surveillance if joining is not visibly
reversible, and a developer tool that acquires that reputation does not recover.

## Privacy invariants

- An unlinked install makes **no requests to the service at all** — no version
  ping, no "do you have a team" check, nothing. The panel's unlinked state is
  rendered from local data only.
- The panel can show what would be sent before anything is sent.
- No key material is stored or received. The repository key is derived from the
  clone on demand (AL 02) and never printed — including by `--explain-payload`
  and in verbose modes.
- Revocation is local-first and immediate.

---

## Steps

1. Icon and state dot in the tab-bar icon group (`media/src/App.tsx`), following
   the existing bell/gear pattern exactly.
2. `media/src/panels/TeamPanel.tsx` — both states, unlinked first.
3. `src/team/pkce.ts`, `src/team/callbackServer.ts`, `src/team/credentials.ts`.
4. `standalone/cli.ts` — `team link`, `team status`, `team leave`; `--device` for
   the fallback flow.
5. VS Code command palette entries for the same three, using the extension's
   existing external-URI handling to open the browser.
6. Tests: state mismatch rejected; timeout closes the listener; refresh; leave
   clears the credential; no network on an unlinked install.

## Acceptance

- Fresh install: the icon is present, the panel opens, everything in it is
  honest, and a packet capture over a full working session shows nothing.
- `team link` completes in a browser and the panel flips to linked.
- `team leave` works with the machine offline.
- The callback listener cannot outlive success, failure or timeout.

## Notes

The consent screen in the browser belongs to SA 03, but its wording is this
repo's concern: it must say the same things in the same words as this panel and
as `--explain-payload`. Bind them with a test rather than maintaining three
descriptions of one promise.
