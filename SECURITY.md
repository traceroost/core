# Security Policy

## Reporting a vulnerability

Please report security issues privately — **not** in a public issue, discussion or pull request.

- **Preferred:** GitHub private vulnerability reporting on this repository —
  [traceroost/core → Security → Report a vulnerability](https://github.com/traceroost/core/security/advisories/new).
- **Or email:** [support@traceroost.com](mailto:support@traceroost.com).

Include what you found, the TraceRoost version (`traceroost --version`, or the version shown at the
bottom-left of the Traces tab), how it runs (VS Code extension, `npx traceroost`, background service,
Docker), your OS, and the steps to reproduce. Please check it still reproduces on the latest release.

## In scope

- **The local servers and their ports** — the dashboard (`UI_PORT`, default 3000), the OTLP HTTP
  receiver (`OTLP_PORT`, default 4318) and the MCP endpoint (`MCP_PORT`, default 4316) run by the
  standalone server, the background service and the Docker image, and the VS Code extension's own
  OTLP receiver. For example: another local process, a web page in your browser (DNS rebinding,
  cross-origin requests) or another device reaching data or actions it shouldn't.
- **LAN mode token auth** — with `BIND_HOST=0.0.0.0` (or `::`, and always in Docker) every request
  to the dashboard, OTLP and MCP ports must carry the access token from `~/.traceroost/config.json`.
  Any way around that check, or a way to read the token, is in scope.
- **MCP** — the MCP tools TraceRoost exposes to coding agents, including anything that lets a
  prompt or a recorded trace read or write outside what those tools are meant to touch.
- **Agent auto-configuration and local files** — what TraceRoost writes into agent settings, its
  data directory, and its handling of trace content (prompts, tool output) on disk and in the
  dashboard (for example script injection from recorded content).

## Out of scope

- Issues that need an attacker who already runs code as your user on your machine.
- Running with `BIND_HOST=0.0.0.0` on an untrusted network and sharing the access token.
- Vulnerabilities in the coding agents themselves (Claude Code, Codex, GitHub Copilot, OpenCode,
  Cursor CLI) or in VS Code — please report those to their vendors.
