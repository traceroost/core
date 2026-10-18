#!/usr/bin/env node
// Watches the places each supported agent documents or implements its OpenTelemetry output, and
// reports what changed since the last run — so a renamed span, a new attribute or a retired event
// reaches a maintainer before a parser in src/ silently stops matching. .github/workflows/otel-watch.yml
// runs this weekly, keeps the state on the `otel-watch` branch (so main gets no bot commits) and
// emails the report when something telemetry-related moved.
//
// Usage: node scripts/otel-watch.mjs <state dir> [--sources <json>] [--no-mail]
//
//   <state dir>     state.json, snapshots/<source id>.txt and reports/<date>.md live here.
//   --sources       a JSON file with the same shape as AGENTS below (tests; ad-hoc runs).
//   --no-mail       build and store the report, send nothing.
//
// Environment:
//   GITHUB_TOKEN              optional; raises the api.github.com rate limit for the commit lists.
//   OTEL_WATCH_GITHUB_API     base URL of the GitHub API (default https://api.github.com).
//   OTEL_WATCH_SMTP_HOST      SMTP relay, implicit TLS (default port 465, OTEL_WATCH_SMTP_PORT).
//   OTEL_WATCH_SMTP_USER / OTEL_WATCH_SMTP_PASS   AUTH LOGIN credentials (SES SMTP credentials work).
//   OTEL_WATCH_MAIL_FROM / OTEL_WATCH_MAIL_TO     sender and recipient(s), comma-separated.
//   OTEL_WATCH_SMTP_CA        optional PEM file to trust instead of the system roots (tests, private relays).
//   OTEL_WATCH_SMTP_SERVERNAME optional TLS server name when it differs from the host (tests).
//   GITHUB_OUTPUT             when set (Actions), `changed=true|false` and `report=<path>` are appended.
//
// Two kinds of source. A `page` is fetched and diffed line-by-line against the stored snapshot; with
// `match`, only added/removed lines matching that pattern count (a changelog has many lines, few of
// them about telemetry). A `repo` lists the commits that touched its paths since the last recorded
// one, through the GitHub commits API. Either kind reports a fetch failure or a status change
// (a documented page disappearing, an undocumented one appearing) instead of crashing the run.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

/** Words that make a changed line worth reporting when a source carries a lot of unrelated text. */
export const TELEMETRY_WORDS =
  "\\b(otel|open ?telemetry|telemetry|otlp|tracing|traces?|spans?|metrics?|gen_ai|exporter|log records?|user[_ ]prompts?|events?|attributes?)\\b";

// What each agent sends is read by the files named in `reads`: when a source below changes, those
// are the files to check (runbooks/README.md → "Review an upstream OpenTelemetry change").
export const AGENTS = [
  {
    agent: "Claude Code",
    reads: ["src/spanSummarizer.ts", "src/claudeTurnJoin.ts", "src/otlpIngest.ts", "src/otelTraceKeys.ts"],
    sources: [
      {
        id: "claude-code-monitoring-docs",
        kind: "page",
        title: "Monitoring docs (metrics, events, span attributes)",
        url: "https://code.claude.com/docs/en/monitoring-usage.md",
      },
      {
        id: "claude-code-changelog",
        kind: "page",
        title: "CHANGELOG.md (telemetry lines only)",
        url: "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
        match: TELEMETRY_WORDS,
      },
    ],
  },
  {
    agent: "Codex",
    reads: ["src/otlpParser.ts", "src/spanSummarizer.ts", "src/otelTraceKeys.ts"],
    sources: [
      {
        id: "codex-otel-crate",
        kind: "repo",
        title: "codex-rs/otel crate and the otel config",
        repo: "openai/codex",
        branch: "main",
        paths: ["codex-rs/otel", "codex-rs/core/src/config/otel.rs", "codex-rs/core/src/otel_init.rs"],
      },
      {
        // docs/config.md is a stub now (the reference moved to developers.openai.com, which this
        // watch cannot diff reliably); the crate README documents the events and attributes.
        id: "codex-otel-readme",
        kind: "page",
        title: "codex-rs/otel/README.md (events, attributes, config keys)",
        url: "https://raw.githubusercontent.com/openai/codex/main/codex-rs/otel/README.md",
      },
    ],
  },
  {
    agent: "GitHub Copilot (Chat)",
    reads: ["src/spanSummarizer.ts", "src/otlpIngest.ts"],
    sources: [
      {
        id: "copilot-chat-otel",
        kind: "repo",
        title: "OTel service, GenAI attributes and events, monitoring docs",
        repo: "microsoft/vscode-copilot-chat",
        branch: "main",
        paths: ["src/platform/otel", "src/extension/otel", "docs/monitoring"],
      },
    ],
  },
  {
    agent: "GitHub Copilot (CLI)",
    reads: ["src/logReader.ts"],
    sources: [
      {
        id: "copilot-cli-changelog",
        kind: "page",
        title: "changelog.md (telemetry lines only) — the CLI itself is closed source",
        url: "https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md",
        match: TELEMETRY_WORDS,
      },
    ],
  },
  {
    agent: "OpenCode",
    reads: ["src/logReader.ts"],
    note: "TraceRoost reads OpenCode's SQLite database, not its (experimental, undocumented) OTel export — this watches the export so we know when it is worth ingesting.",
    sources: [
      {
        id: "opencode-observability",
        kind: "repo",
        title: "packages/util observability (OTLP export)",
        repo: "anomalyco/opencode",
        branch: "dev",
        paths: ["packages/util/src/observability", "packages/util/src/observability.ts"],
      },
    ],
  },
  {
    agent: "Cursor",
    reads: ["src/logReader.ts"],
    note: "Nothing public to watch: Cursor's OpenTelemetry export is enterprise-only and its CLI is closed source. Add a source here when one appears.",
    sources: [],
  },
];

const PAGE_LINE_LIMIT = 80; // changed lines shown per page source before "… and N more"
const COMMIT_LIMIT = 40; // commits shown per repo source

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests and ad-hoc use)

export function normalizePage(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** Order-insensitive line diff: lines added to / removed from the multiset of lines. */
export function lineChanges(before, after) {
  const count = (text) => {
    const m = new Map();
    for (const line of text.split("\n")) if (line.trim()) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const added = [];
  const removed = [];
  for (const [line, n] of b) {
    const extra = n - (a.get(line) ?? 0);
    for (let i = 0; i < extra; i++) added.push(line);
  }
  for (const [line, n] of a) {
    const extra = n - (b.get(line) ?? 0);
    for (let i = 0; i < extra; i++) removed.push(line);
  }
  return { added, removed };
}

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Renders one run's report. `results` is one entry per source (see checkSource). */
export function renderReport({ agents, results, date, stateRef }) {
  const byId = new Map(results.map((r) => [r.source.id, r]));
  const out = [];
  const changedAgents = [];
  let noteworthy = 0;
  let errors = 0;

  out.push(`# OpenTelemetry upstream watch — ${date}`);
  out.push("");
  for (const agent of agents) {
    out.push(`## ${agent.agent}`);
    out.push("");
    if (agent.note) out.push(`_${agent.note}_`, "");
    if (agent.reads?.length)
      out.push(`Read by: ${agent.reads.map((f) => `\`${f}\``).join(", ")}`, "");
    if (!agent.sources.length) {
      out.push("No sources watched.", "");
      continue;
    }
    let agentChanged = false;
    for (const source of agent.sources) {
      const r = byId.get(source.id);
      const link = source.kind === "page" ? source.url : `https://github.com/${source.repo}`;
      out.push(`### ${source.title ?? source.id}`);
      out.push("");
      out.push(`<${link}>`);
      out.push("");
      if (!r) {
        out.push("- not checked", "");
        continue;
      }
      if (r.error) {
        errors++;
        out.push(`- **Could not check:** ${r.error}`, "");
        continue;
      }
      if (r.baseline) {
        out.push(`- Baseline recorded${r.detail ? ` (${r.detail})` : ""}; changes are reported from the next run on.`, "");
        continue;
      }
      if (r.statusChange) {
        noteworthy++;
        agentChanged = true;
        out.push(`- **Status changed: ${r.statusChange}**`);
      }
      if (r.kind === "page") {
        if (r.shown.added.length || r.shown.removed.length) {
          noteworthy++;
          agentChanged = true;
          out.push(
            `- Changed: ${r.shown.added.length + r.shown.removed.length}${source.match ? " telemetry-related" : ""} line(s)${r.hiddenCount ? ` (and ${r.hiddenCount} other changed line(s) not shown)` : ""}`,
          );
          out.push("");
          out.push("```diff");
          for (const l of r.shown.removed) out.push(`- ${l}`);
          for (const l of r.shown.added) out.push(`+ ${l}`);
          if (r.truncated) out.push(`… and ${r.truncated} more`);
          out.push("```");
        } else if (r.quietChange) {
          out.push(`- Changed, but no line matched the telemetry pattern (${r.quietChange} line(s) differ).`);
        } else if (!r.statusChange) {
          out.push("- No change.");
        }
      } else if (r.kind === "repo") {
        if (r.commits.length) {
          noteworthy++;
          agentChanged = true;
          out.push(`- ${r.commits.length} commit(s) touched ${source.paths.map((p) => `\`${p}\``).join(", ")}:`);
          for (const c of r.commits.slice(0, COMMIT_LIMIT))
            out.push(`  - ${c.date.slice(0, 10)} [\`${c.sha.slice(0, 7)}\`](${c.url}) ${c.message}`);
          if (r.commits.length > COMMIT_LIMIT) out.push(`  - … and ${r.commits.length - COMMIT_LIMIT} more`);
        } else if (!r.statusChange) {
          out.push("- No commits.");
        }
      }
      out.push("");
    }
    if (agentChanged) changedAgents.push(agent.agent);
  }
  if (stateRef) out.push(`---`, ``, `Snapshots and past reports: ${stateRef}`, "");
  return { text: out.join("\n"), changedAgents, noteworthy, errors };
}

// ---------------------------------------------------------------------------------------------
// Fetching

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "traceroost-otel-watch", ...headers }, redirect: "follow" });
  const text = await res.text();
  return { status: res.status, text };
}

function githubHeaders() {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function checkPage(source, prev, stateDir) {
  let fetched;
  try {
    fetched = await fetchText(source.url);
  } catch (err) {
    return { source, kind: "page", error: `fetch failed: ${err?.message ?? err}` };
  }
  const status = fetched.status;
  const text = status === 200 ? normalizePage(fetched.text) : "";
  const snapshotFile = path.join(stateDir, "snapshots", `${source.id}.txt`);
  const next = { kind: "page", status, sha: sha256(text), checkedAt: new Date().toISOString() };
  const result = { source, kind: "page", next, text, snapshotFile, shown: { added: [], removed: [] } };

  if (!prev) {
    result.baseline = true;
    result.detail = status === 200 ? `${text.split("\n").length} lines` : `HTTP ${status}`;
    return result;
  }
  if (prev.status !== status) result.statusChange = `HTTP ${prev.status} → HTTP ${status}`;
  if (status !== 200) return result;

  const before = fs.existsSync(snapshotFile) ? normalizePage(fs.readFileSync(snapshotFile, "utf8")) : "";
  if (sha256(before) === next.sha) return result;

  const { added, removed } = lineChanges(before, text);
  const re = source.match ? new RegExp(source.match, "i") : null;
  const keep = (l) => !re || re.test(l);
  const shownAdded = added.filter(keep);
  const shownRemoved = removed.filter(keep);
  result.hiddenCount = added.length + removed.length - shownAdded.length - shownRemoved.length;
  const total = shownAdded.length + shownRemoved.length;
  if (total > PAGE_LINE_LIMIT) {
    const r = shownRemoved.slice(0, Math.ceil(PAGE_LINE_LIMIT / 2));
    result.shown = { removed: r, added: shownAdded.slice(0, PAGE_LINE_LIMIT - r.length) };
    result.truncated = total - PAGE_LINE_LIMIT;
  } else {
    result.shown = { added: shownAdded, removed: shownRemoved };
  }
  if (!total) result.quietChange = added.length + removed.length;
  return result;
}

async function listCommits(source, since) {
  const api = (process.env.OTEL_WATCH_GITHUB_API ?? "https://api.github.com").replace(/\/$/, "");
  const seen = new Map();
  for (const p of source.paths) {
    const q = new URLSearchParams({ sha: source.branch ?? "main", path: p, per_page: "100" });
    if (since) q.set("since", since);
    const url = `${api}/repos/${source.repo}/commits?${q}`;
    const res = await fetch(url, { headers: { "User-Agent": "traceroost-otel-watch", ...githubHeaders() } });
    if (res.status === 404 || res.status === 422) {
      // 404: repo or branch gone; 422: an unknown path on some API versions. Either way the
      // source list needs attention — reported, not thrown.
      throw new Error(`GET ${url}: ${res.status} (does \`${p}\` still exist on ${source.repo}@${source.branch ?? "main"}?)`);
    }
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    for (const c of await res.json()) {
      if (seen.has(c.sha)) continue;
      seen.set(c.sha, {
        sha: c.sha,
        date: c.commit?.committer?.date ?? c.commit?.author?.date ?? "",
        message: (c.commit?.message ?? "").split("\n")[0].slice(0, 120),
        url: c.html_url ?? `https://github.com/${source.repo}/commit/${c.sha}`,
      });
    }
  }
  return [...seen.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

async function checkRepo(source, prev) {
  let commits;
  try {
    commits = await listCommits(source, prev?.lastCommitAt);
  } catch (err) {
    return { source, kind: "repo", error: err?.message ?? String(err) };
  }
  const newest = commits[0];
  const next = {
    kind: "repo",
    checkedAt: new Date().toISOString(),
    lastCommit: newest?.sha ?? prev?.lastCommit ?? null,
    lastCommitAt: newest?.date ?? prev?.lastCommitAt ?? null,
  };
  if (!prev) {
    return {
      source,
      kind: "repo",
      next,
      baseline: true,
      detail: newest ? `latest commit ${newest.sha.slice(0, 7)} on ${newest.date.slice(0, 10)}` : "no commits found",
      commits: [],
    };
  }
  // `since` is inclusive of the second it names, so the recorded commit comes back too.
  const fresh = commits.filter((c) => c.sha !== prev.lastCommit && (!prev.lastCommitAt || c.date >= prev.lastCommitAt));
  return { source, kind: "repo", next, commits: fresh };
}

// ---------------------------------------------------------------------------------------------
// Mail: a minimal SMTP client over implicit TLS with AUTH LOGIN — enough for SES, no dependency.

function smtpSession(socket) {
  let buffer = "";
  const waiters = [];
  const replies = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // A multi-line reply continues while the 4th char is '-'.
      if (line.length >= 4 && line[3] === "-") continue;
      const reply = line;
      const w = waiters.shift();
      if (w) w.resolve(reply);
      else replies.push(reply);
    }
  });
  const fail = (err) => {
    while (waiters.length) waiters.shift().reject(err);
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("SMTP connection closed")));
  const read = () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject })));
  const expect = async (want, what) => {
    const reply = await read();
    if (!reply.startsWith(want)) throw new Error(`SMTP ${what}: expected ${want}, got "${reply}"`);
    return reply;
  };
  const send = async (line, want, what) => {
    socket.write(line + "\r\n");
    return expect(want, what ?? line.split(" ")[0]);
  };
  return { expect, send };
}

const assertHeaderSafe = (name, value) => {
  if (/[\r\n]/.test(value)) throw new Error(`mail ${name} must not contain CR/LF`);
  return value;
};

export function buildMessage({ from, to, subject, text }) {
  assertHeaderSafe("from", from);
  for (const t of to) assertHeaderSafe("to", t);
  const encodedSubject = `=?UTF-8?B?${Buffer.from(assertHeaderSafe("subject", subject), "utf8").toString("base64")}?=`;
  const body = text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@traceroost-otel-watch>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
}

export async function sendMail({ host, port, user, pass, from, to, subject, text, ca, servername }) {
  const message = buildMessage({ from, to, subject, text });
  const socket = tls.connect({ host, port, servername: servername ?? host, ca: ca ? [ca] : undefined });
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
  });
  const s = smtpSession(socket);
  try {
    await s.expect("220", "greeting");
    await s.send("EHLO traceroost-otel-watch", "250");
    await s.send("AUTH LOGIN", "334");
    await s.send(Buffer.from(user).toString("base64"), "334", "username");
    await s.send(Buffer.from(pass).toString("base64"), "235", "password");
    await s.send(`MAIL FROM:<${from.replace(/^.*<|>.*$/g, "")}>`, "250");
    for (const t of to) await s.send(`RCPT TO:<${t.replace(/^.*<|>.*$/g, "")}>`, "250");
    await s.send("DATA", "354");
    await s.send(message + "\r\n.", "250", "message");
    await s.send("QUIT", "221");
  } finally {
    socket.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Main

function mailConfigFromEnv(env) {
  const host = env.OTEL_WATCH_SMTP_HOST;
  const from = env.OTEL_WATCH_MAIL_FROM;
  const to = (env.OTEL_WATCH_MAIL_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!host || !from || !to.length) return null;
  return {
    host,
    port: Number(env.OTEL_WATCH_SMTP_PORT ?? 465),
    user: env.OTEL_WATCH_SMTP_USER ?? "",
    pass: env.OTEL_WATCH_SMTP_PASS ?? "",
    from,
    to,
    ca: env.OTEL_WATCH_SMTP_CA ? fs.readFileSync(env.OTEL_WATCH_SMTP_CA, "utf8") : undefined,
    servername: env.OTEL_WATCH_SMTP_SERVERNAME,
  };
}

export async function run({ stateDir, agents, mail, date = new Date().toISOString().slice(0, 10), stateRef }) {
  fs.mkdirSync(path.join(stateDir, "snapshots"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "reports"), { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { version: 1, sources: {}, runs: [] };

  const results = [];
  for (const agent of agents) {
    for (const source of agent.sources) {
      const prev = state.sources[source.id];
      const r = source.kind === "repo" ? await checkRepo(source, prev) : await checkPage(source, prev, stateDir);
      results.push(r);
    }
  }

  const report = renderReport({ agents, results, date, stateRef });
  const changed = report.noteworthy > 0;

  // Persist only what was successfully checked; a failed source keeps its previous snapshot so the
  // next run diffs against the last good copy.
  for (const r of results) {
    if (r.error || !r.next) continue;
    state.sources[r.source.id] = r.next;
    if (r.kind === "page" && r.next.status === 200) fs.writeFileSync(r.snapshotFile, r.text + "\n");
  }
  state.runs = [...(state.runs ?? []).slice(-51), { at: new Date().toISOString(), changed, noteworthy: report.noteworthy, errors: report.errors }];
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  const reportFile = path.join(stateDir, "reports", `${date}.md`);
  fs.writeFileSync(reportFile, report.text + "\n");
  fs.writeFileSync(path.join(stateDir, "latest.md"), report.text + "\n");

  let mailed = false;
  if (changed && mail) {
    const subject = `[TraceRoost] OpenTelemetry upstream changes: ${report.changedAgents.join(", ")} (${date})`;
    await sendMail({ ...mail, subject, text: report.text });
    mailed = true;
  }
  return { ...report, changed, mailed, reportFile };
}

async function main() {
  const args = process.argv.slice(2);
  const positional = [];
  let sourcesFile = null;
  let noMail = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sources") sourcesFile = args[++i];
    else if (args[i] === "--no-mail") noMail = true;
    else positional.push(args[i]);
  }
  const [stateDir] = positional;
  if (!stateDir) {
    console.error("usage: node scripts/otel-watch.mjs <state dir> [--sources <json>] [--no-mail]");
    process.exit(2);
  }
  const agents = sourcesFile ? JSON.parse(fs.readFileSync(sourcesFile, "utf8")) : AGENTS;
  const mail = noMail ? null : mailConfigFromEnv(process.env);
  const stateRef = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}/tree/otel-watch` : undefined;

  const result = await run({ stateDir, agents, mail, stateRef });
  process.stdout.write(result.text + "\n");
  const summary = `changed=${result.changed} noteworthy=${result.noteworthy} errors=${result.errors} mailed=${result.mailed}${!noMail && !mail ? " (mail not configured)" : ""}`;
  console.error(summary);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nreport=${result.reportFile}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
