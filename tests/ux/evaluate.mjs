import { chromium } from "playwright";
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import assert from "node:assert/strict";

// Mirrors media/src/hash.ts formatTraceIdHash exactly, so this test can compute the normalized
// hash the UI displays/searches for a known fixture trace ID without importing the .ts module.
function formatTraceIdHash(id) {
  let h1 = 0xdeadbeef ^ id.length;
  let h2 = 0x41c6ce57 ^ id.length;
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0")
  );
}

// Exercise the shipped dashboard and its message boundary, with synthetic data.
// No standalone server, log readers, agent configuration, or account access.
await mkdir("test-results/ux", { recursive: true });
await build({
  entryPoints: ["media/src/dashboard.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "test-results/ux/dashboard.js",
  jsx: "automatic",
  jsxImportSource: "preact",
});
const standalone = await readFile("standalone/server.ts", "utf8");
const theme = standalone.slice(
  standalone.indexOf("  <style>") + 9,
  standalone.indexOf("  </style>"),
);
const sessions = Array.from({ length: 64 }, (_, i) => ({
  sessionId: `ux-${i}`,
  traceId: `trace-${i}`,
  source: ["copilot", "claude_code", "codex", "opencode"][i % 4],
  dataSource: i % 2 ? "log" : "otel",
  initiator: ["user", "agent", "api"][i % 3],
  workspace: `/fixtures/${i % 2 ? "cloud" : "core"}`,
  userRequest: `Task ${String(i).padStart(2, "0")} ${i % 2 ? "Implement a much longer request with enough text to exercise truncation" : "Fix bug"}`,
  model: i % 2 ? "gpt-5" : "claude-sonnet-4",
  turns: i + 1,
  inputTokens: (i + 1) * 700,
  outputTokens: (i + 1) * 125,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  cacheHitRate: 0,
  durationMs: (i + 1) * 1234,
  startTime: new Date(Date.now() - i * 3600000).toISOString(),
  filesRead: [],
  filesSearched: [],
  filesChanged: [],
  filesWritten: [],
  toolCounts: {},
  totalToolCalls: 0,
  totalLlmCalls: 1,
  errors: 0,
  outcome: "text_response",
  timeline: [],
  backgroundSpans: [],
  loopSignals: [],
}));
const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TraceRoost UX evaluation</title><style>${theme}</style><link rel="stylesheet" href="/dashboard.css"></head><body><div id="sa-main"><div id="app"></div></div><script>
window.__STANDALONE__ = true; window.__VERSION__ = 'UX fixture';
window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: msg => {
 if (msg.type === 'searchSessions') setTimeout(() => window.postMessage({ type: 'searchResults', sessions: ${JSON.stringify(sessions)}, totalCount: 64, context: msg.context }, '*'), 150);
}});
</script><script src="/dashboard.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  if (req.url === "/dashboard.js" || req.url === "/dashboard.css") {
    res.setHeader(
      "Content-Type",
      req.url.endsWith(".css") ? "text/css" : "text/javascript",
    );
    res.end(await readFile(`test-results/ux${req.url}`));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch();
const results = [];
try {
  for (const mode of [
    { name: "desktop-light", width: 1440, height: 900, colorScheme: "light" },
    { name: "desktop-dark", width: 1440, height: 900, colorScheme: "dark" },
    { name: "mobile-light", width: 390, height: 844, colorScheme: "light" },
    { name: "mobile-dark", width: 390, height: 844, colorScheme: "dark" },
  ]) {
    const context = await browser.newContext({
      viewport: { width: mode.width, height: mode.height },
      colorScheme: mode.colorScheme,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator("#sessions-content").waitFor();
    await page.evaluate(
      (sessions) =>
        window.postMessage(
          { type: "update", sessionSummary: { sessions } },
          "*",
        ),
      sessions,
    );
    await page.locator("#sessions-content tbody tr").first().waitFor();
    // The Traces tab search field (#tr-filter-prompt) matches prompt text, the raw Trace ID,
    // and the normalized display hash shown/copied from a trace's expanded detail — a pasted
    // value from any of those three should find the trace (media/src/state.ts, hash.ts). Run
    // before the geometry watch below: collapsing to a single matching row is a legitimate,
    // large reflow (not animation jitter) that the stationary-elements check isn't meant to catch.
    const searchInput = () => page.getByPlaceholder("Text or Trace ID");
    await searchInput().fill("Task 01");
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("#sessions-content tbody tr").count(),
      1,
      "search by prompt text",
    );
    await searchInput().fill("trace-63");
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("#sessions-content tbody tr").count(),
      1,
      "search by raw trace ID",
    );
    await searchInput().fill(formatTraceIdHash("trace-63"));
    await page.waitForTimeout(100);
    assert.equal(
      await page.locator("#sessions-content tbody tr").count(),
      1,
      "search by normalized trace ID hash",
    );
    await searchInput().fill("no-matching-trace");
    await page.waitForTimeout(100);
    assert.match(
      await page.locator("#sessions-content tbody").innerText(),
      /No traces match/,
    );
    await searchInput().fill("");
    await page.waitForTimeout(100);
    await page.locator("#sessions-content tbody tr").first().waitFor();
    await page.screenshot({
      path: `test-results/ux/${mode.name}-traces.png`,
      fullPage: true,
    });
    // Sample every animation frame, including transient movement, not just final state.
    // .trace-pagination is deliberately excluded: it sits in normal flow below the trace table,
    // so its y-position tracks the table's height, which itself tracks the filtered row count —
    // the filter/repo/time-range interactions below legitimately shrink or grow that count, and
    // that's reflow, not jank. Everything else here sits above/beside the variable content and
    // must stay put regardless of how many rows are filtered in or out.
    // .tr-trailing-controls (Clear Filters + paging, at the end of .time-range-bar) is excluded
    // too: a "Refreshing" spinner mounts/unmounts right before it while the 24h/All time-range
    // buttons below are in flight, nudging it sideways on narrow (flex-wrap) viewports — expected
    // reflow from a real, momentary loading state, not jank.
    await page.evaluate(() => {
      const elements = [
        ...document.querySelectorAll(
          ".tabs, .time-range-bar, .search-filter-controls, #sessions-content th, .time-range-bar button, .search-filter-controls button, .search-filter-controls input, .search-filter-controls select",
        ),
      ].filter(el => !el.closest(".tr-trailing-controls"));
      function rect(el) {
        const box = el.getBoundingClientRect().toJSON();
        // User-initiated scrolling to reach offscreen controls is intentional.
        // Compare content coordinates; resizing/reflow still fails this check.
        for (
          let parent = el.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          box.x += parent.scrollLeft;
          box.y += parent.scrollTop;
        }
        return box;
      }
      const initial = elements.map(rect);
      window.uxGeometry = { max: 0, frames: 0, running: true, missing: 0 };
      function frame() {
        elements.forEach((el, i) => {
          if (!el.isConnected) {
            window.uxGeometry.missing++;
            return;
          }
          const r = rect(el);
          for (const key of ["x", "y", "width", "height"])
            window.uxGeometry.max = Math.max(
              window.uxGeometry.max,
              Math.abs(r[key] - initial[i][key]),
            );
        });
        window.uxGeometry.frames++;
        if (window.uxGeometry.running) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    // Existing accessible surfaces, so this also reproduces failures on the original code.
    await page
      .locator("#sessions-content th")
      .filter({ hasText: "Tokens" })
      .getByRole("button")
      .click();
    await page.waitForTimeout(100);
    await page
      .locator("#sessions-content th")
      .filter({ hasText: "Tokens" })
      .getByRole("button")
      .click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator("th[aria-sort=ascending]").count(), 1);
    for (const name of ["Claude", "Codex", "All"]) {
      await page
        .locator(".time-range-bar")
        .getByRole("button", { name, exact: true })
        .last()
        .click();
      await page.waitForTimeout(100);
    }
    for (const title of [
      "Log-file traces only",
      "Show all data sources",
      "Agent-spawned sub-tasks and non-interactive claude -p calls",
    ]) {
      await page.getByTitle(title, { exact: true }).click();
      await page.waitForTimeout(100);
    }
    // "Show all traces" also titles the Outcome filter's own All pill, so scope to the last
    // match — the From/initiator row's All pill, reset here after the toggle above.
    await page.getByTitle("Show all traces", { exact: true }).last().click();
    await page.waitForTimeout(100);
    // The project/workspace filter is now a freeform "Repo" input (matchesRepoQuery,
    // media/src/state.ts), not a <select> — it falls back to a plain path substring match here
    // since these fixtures have no resolvable repoInfo.
    await page.getByLabel("Repo", { exact: true }).fill("cloud");
    await page.waitForTimeout(100);
    assert.ok(
      (await page.locator("#sessions-content tbody tr").count()) > 0,
      "repo filter narrows to matching workspaces",
    );
    await page.getByLabel("Repo", { exact: true }).fill("");
    for (const label of ["24h", "All"]) {
      await page
        .locator(".time-range-bar")
        .getByRole("button", { name: label, exact: true })
        .first()
        .click();
      await page.waitForTimeout(400);
    }
    await page.evaluate(
      (sessions) =>
        window.postMessage(
          {
            type: "update",
            sessionSummary: {
              sessions: sessions.map((s) => ({
                ...s,
                inputTokens: s.inputTokens * 1000,
              })),
            },
          },
          "*",
        ),
      sessions,
    );
    await page.waitForTimeout(100);
    const geometry = await page.evaluate(() => {
      window.uxGeometry.running = false;
      return window.uxGeometry;
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    const tabs = [];
    for (const label of [
      "Analytics",
      "Advisor",
      "Export",
      "Import",
      "Traces",
    ]) {
      await page
        .locator(".tabs")
        .getByRole("button", { name: label, exact: true })
        .click();
      await page.waitForTimeout(100);
      await page.screenshot({
        path: `test-results/ux/${mode.name}-${label.toLowerCase()}.png`,
        fullPage: true,
      });
      tabs.push(label);
    }
    await page
      .getByRole("button", { name: "Expand trace", exact: true })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await page
        .getByRole("button", { name: "Collapse trace", exact: true })
        .count(),
      1,
    );
    await page
      .getByRole("button", { name: "Collapse trace", exact: true })
      .press("Enter");
    results.push({ mode: mode.name, geometry, overflow, errors, tabs });
    await context.close();
  }
  await writeFile(
    "test-results/ux/results.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
  for (const result of results) {
    assert.equal(result.overflow, false, `${result.mode}: document overflow`);
    assert.deepEqual(result.errors, [], `${result.mode}: browser errors`);
    assert.equal(
      result.geometry.missing,
      0,
      `${result.mode}: stationary elements were removed`,
    );
    assert.ok(result.geometry.frames > 2);
    assert.ok(
      result.geometry.max <= 1,
      `${result.mode}: ${result.geometry.max}px jitter`,
    );
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
