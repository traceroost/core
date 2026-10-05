/**
 * The standalone dashboard page — the HTML shell standalone/server.ts serves at `/`. Everything
 * the server inlines (the first-paint session summary, sidebar state, version, ingest progress)
 * arrives through `DashboardHtmlVars`; the template itself has no access to server state, which
 * is what lets it be rendered in a unit test (standalone/dashboardHtml.test.ts asserts the
 * Content-Security-Policy contract: every `<script>` nonced, no inline event handlers — see
 * standalone/dashboardCsp.ts). tests/ux/serve.ts reads the `<style>` block out of this file.
 */

export interface DashboardHtmlVars {
  /** Per-response CSP nonce (dashboardCsp.ts) — on every `<script>` tag, inline or `src=`. */
  nonce: string
  packageVersion: string
  /** `JSON.stringify` of the server's collectorConflict (or `null`). */
  collectorConflictJson: string
  /** `JSON.stringify` of the historical-ingest progress (or `null`). */
  logIngestJson: string
  /** sseSync's revision the inlined sessions are at. */
  sessionRev: number
  /** The stripped session summary, already run through safeJsonText (safe inside `<script>`). */
  sessionSummaryJson: string
  /** safeJson() of the live sidebar payload. */
  sidebarInitJson: string
}

/** The standalone page's Org-panel transport: the webview posts `org*` messages, this polyfill
 *  turns them into `/api/org` requests. Empty in the core edition — its Org panel is a stub that
 *  never posts one — so no org wiring reaches the page at all. A literal
 *  `process.env.TRACEROOST_EDITION` check (esbuild.js defines it) so the core build drops the
 *  string entirely rather than just never using it. */
let ORG_FETCH_SHIM = ''
if (process.env.TRACEROOST_EDITION !== 'core') {
  ORG_FETCH_SHIM = ` else if (msg.type && (msg.type === 'getOrgStatus' || msg.type.indexOf('org') === 0)) {
            fetch('/api/org', {
              method: msg.type === 'getOrgStatus' ? 'GET' : 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: msg.type === 'getOrgStatus' ? undefined : JSON.stringify(msg),
            }).then(function(r) { return r.json(); }).then(function(data) {
              (data.messages || []).forEach(function(m) {
                if (m.type === 'orgLinkUrl' && m.url) { window.open(m.url, '_blank'); }
                window.dispatchEvent(new MessageEvent('message', { data: m }));
              });
            }).catch(function() {
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'orgActionResult', ok: false, error: 'request failed' } }));
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'orgError', error: 'request failed' } }));
            });
            return;
          }`
}

export function renderDashboardHtml(v: DashboardHtmlVars): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script nonce="${v.nonce}">
    // Applies a stored dark/light override before first paint, so the page never flashes the
    // wrong theme for a frame — must run before the <style> block below resolves the CSS custom
    // properties it depends on. No entry (or "system") means no attribute: the prefers-color-scheme
    // media query in that block handles it instead. See media/src/state.ts's setThemePreference,
    // which is the only other writer of this key.
    (function () {
      try {
        var t = localStorage.getItem('traceroost-theme');
        if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
      } catch (e) { /* localStorage unavailable — falls back to system preference below */ }
    })();
  </script>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TraceRoost</title>
  <!-- Versioned so an upgrade always gets a fresh icon: browsers cache favicons per URL very
       persistently, and AgentLens served its old icon at this same /mascot.png. The server
       ignores the query string. -->
  <link rel="icon" href="/mascot.png?v=${encodeURIComponent(v.packageVersion)}" type="image/png">
  <link rel="stylesheet" href="/dashboard.css">
  <style>
    /* ── VS Code theme variable shim ─────────────────────────────────────────
       Standalone has no real VS Code host to supply --vscode-* variables, so this
       defines them directly. Three states: System (default — follows
       prefers-color-scheme), Dark, Light (explicit override via the [data-theme]
       attribute the script above sets). Toggle lives in Settings — see
       media/src/tabs/Settings.tsx's ThemeToggle and .staged-issues/theme-toggle.md.
       Not used in the VS Code webview at all — that has its own HTML in
       src/dashboardPanel.ts and always inherits the IDE's real --vscode-* values. ── */

    /* Light palette — the default, before any media query or explicit override applies.
       color-scheme tells the browser which mode *native* form control chrome (dropdowns,
       checkboxes, date pickers) should render in — without it, those follow the OS/browser's own
       dark-mode detection independently of the custom colors above, which is why they kept
       rendering dark even when everything else correctly switched to light. */
    :root {
      color-scheme: light;
      --agent-copilot: #087e96; --agent-claude: #c2410c; --agent-codex: #7c3aed;
      --vscode-editor-background:       #ffffff;
      --vscode-foreground:              #1f2328;
      --vscode-panel-border:            #d0d7de;
      --vscode-textLink-foreground:     #0969da;
      --vscode-descriptionForeground:   #656d76;
      --vscode-list-hoverBackground:    #f3f4f6;
      --vscode-editorWidget-background: #f6f8fa;
      --vscode-testing-iconFailed:      #cf222e;
      --vscode-testing-iconPassed:      #1a7f37;
      --vscode-font-family:             -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      --vscode-dropdown-background:     #ffffff;
      --vscode-dropdown-border:         #d0d7de;
      --vscode-dropdown-foreground:     #1f2328;
      --vscode-button-background:       #0969da;
      --vscode-button-foreground:       #ffffff;
      --vscode-button-hoverBackground:  #0860ca;

      /* Aliases for --vscode-* names real VS Code exposes that this shim otherwise never defined —
         components referencing them (input fields, list selection highlight) were silently falling
         back to their hardcoded (dark) fallback value in every theme, since an undefined custom
         property with a var() fallback ignores the current theme entirely. Defined once here rather
         than duplicated into the dark blocks below — custom property resolution follows the cascade
         at use time, so these keep tracking whatever --vscode-dropdown-background (etc.) and
         --vscode-list-hoverBackground currently resolve to in each theme, without needing to be
         redeclared per theme. */
      --vscode-input-background:              var(--vscode-dropdown-background);
      --vscode-input-border:                  var(--vscode-dropdown-border);
      --vscode-input-foreground:              var(--vscode-dropdown-foreground);
      --vscode-list-activeSelectionBackground: var(--vscode-list-hoverBackground);
      --vscode-focusBorder:                   var(--vscode-textLink-foreground);

      /* Status/chart colors — semantic accents that don't need to invert with theme (these stay
         legible against both a white and a dark background at these saturations). Values match the
         one fallback each call site already used consistently, so defining these doesn't also
         change how they've looked in dark mode all along — it only fixes light mode, which
         previously got the same dark-tuned fallback since the variable itself was never defined. */
      --vscode-editorInfo-foreground:    #4fc3f7;
      --vscode-editorWarning-foreground: #cca700;
      --vscode-errorForeground:          #f48771;
      --vscode-charts-blue:              #4fc3f7;
      --vscode-charts-green:             #1a7f37;
      --vscode-charts-red:               #e57373;
      --vscode-charts-yellow:            #ffb74d;
    }

    /* System preference is dark, and the user hasn't explicitly forced Light. */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        color-scheme: dark;
      --vscode-charts-green: #81c784;
      --agent-copilot: #00EAFF; --agent-claude: #FFB085; --agent-codex: #F0FF42;
        --vscode-editor-background:       #1e1e1e;
        --vscode-foreground:              #cccccc;
        --vscode-panel-border:            #3e3e42;
        --vscode-textLink-foreground:     #4fc3f7;
        --vscode-descriptionForeground:   #9d9d9d;
        --vscode-list-hoverBackground:    #2a2d2e;
        --vscode-editorWidget-background: #252526;
        --vscode-testing-iconFailed:      #f44747;
        --vscode-testing-iconPassed:      #4ec994;
        --vscode-dropdown-background:     #3c3c3c;
        --vscode-dropdown-border:         #616161;
        --vscode-dropdown-foreground:     #f0f0f0;
        --vscode-button-background:       #0e639c;
        --vscode-button-foreground:       #ffffff;
        --vscode-button-hoverBackground:  #1177bb;
      }
    }

    /* Explicit Dark override, regardless of system preference. */
    :root[data-theme="dark"] {
      color-scheme: dark;
      --vscode-charts-green: #81c784;
      --agent-copilot: #00EAFF; --agent-claude: #FFB085; --agent-codex: #F0FF42;
      --vscode-editor-background:       #1e1e1e;
      --vscode-foreground:              #cccccc;
      --vscode-panel-border:            #3e3e42;
      --vscode-textLink-foreground:     #4fc3f7;
      --vscode-descriptionForeground:   #9d9d9d;
      --vscode-list-hoverBackground:    #2a2d2e;
      --vscode-editorWidget-background: #252526;
      --vscode-testing-iconFailed:      #f44747;
      --vscode-testing-iconPassed:      #4ec994;
      --vscode-dropdown-background:     #3c3c3c;
      --vscode-dropdown-border:         #616161;
      --vscode-dropdown-foreground:     #f0f0f0;
      --vscode-button-background:       #0e639c;
      --vscode-button-foreground:       #ffffff;
      --vscode-button-hoverBackground:  #1177bb;
    }

    /* ── Standalone layout ───────────────────────────────────────────────── */
    html, body { height: 100%; overflow: hidden; margin: 0; padding: 0; }
    body { padding: 0; }
    #sa-wrap { display: flex; height: 100vh; width: 100vw; overflow: hidden; }

    /* ── Sidebar panel ───────────────────────────────────────────────────── */
    #sa-sidebar {
      width: 260px;
      min-width: 260px;
      background: var(--vscode-editorWidget-background);
      border-right: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      overflow: hidden;
      transition: width 0.15s ease, min-width 0.15s ease;
    }
    #sa-sidebar.sa-collapsed { width: 0; min-width: 0; }

    /* Sidebar content — shared CSS classes with sidebarWebview.ts */
    .sb-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; }
    .sb-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .sb-row { display: flex; align-items: center; gap: 6px; }
    .sb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .sb-dot.active { background: #56D364; animation: sbPulse 1.5s ease-in-out infinite; }
    .sb-dot.idle { background: var(--vscode-descriptionForeground); opacity: 0.5; }
    @keyframes sbPulse { 0%,100% { opacity:1;transform:scale(1); } 50% { opacity:0.5;transform:scale(1.4); } }
    .sb-status { font-size: 12px; font-weight: 600; }
    .sb-muted { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .sb-prompt { font-size: 10px; color: var(--vscode-foreground); opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 3px 0 2px; font-style: italic; }
    .sb-model { font-size: 10px; color: var(--vscode-textLink-foreground); margin-bottom: 4px; }
    #sa-sidebar canvas { display: block; width: 100%; height: 80px; }
    .sb-turn-label { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
    .sb-plan-meters { font-size: 10px; color: var(--vscode-descriptionForeground); padding-bottom: 6px; cursor: pointer; }
    .sb-plan-meters:hover { color: var(--vscode-foreground); }
    .sb-plan-row { display: flex; align-items: center; gap: 6px; font-size: 10px; margin-top: 3px; }
    .sb-plan-label { width: 18px; color: var(--vscode-descriptionForeground); }
    .sb-plan-bar { flex: 1; height: 6px; border-radius: 3px; background: rgba(128,128,128,.25); overflow: hidden; }
    .sb-plan-fill { height: 100%; background: var(--vscode-charts-blue, #4fc3f7); }
    .sb-plan-fill.warn { background: var(--vscode-charts-yellow, #f6a623); }
    .sb-plan-fill.crit { background: var(--vscode-charts-red, #f44747); }
    .sb-plan-pct { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
    .sb-plan-note { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; line-height: 1.4; }
    .sb-plan-note.warn { color: var(--vscode-charts-yellow, #f6a623); }
    .sb-plan-blocked { font-size: 11px; font-weight: 600; color: var(--vscode-charts-red, #f44747); margin-bottom: 2px; }
    #sb-plan-limit.warn { border-color: var(--vscode-charts-yellow, #f6a623); }
    #sb-plan-limit.blocked { border-color: var(--vscode-charts-red, #f44747); }
    .sb-burn { font-size: 12px; font-weight: 600; color: var(--vscode-charts-green, #81c784); }
    .sb-counters { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; text-align: center; }
    .sb-counter-val { font-size: 16px; font-weight: 700; color: var(--vscode-textLink-foreground); }
    .sb-counter-key { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.3px; }
.sb-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
#sa-toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#333; color:#fff; padding:8px 16px; border-radius:4px; font-size:12px; z-index:9999; opacity:0; transition:opacity 0.2s; pointer-events:none; white-space:nowrap; box-shadow:0 2px 8px rgba(0,0,0,0.4); }
    #sa-toast.visible { opacity:1; }

    /* ── Main panel ──────────────────────────────────────────────────────── */
    #sa-main { flex: 1; overflow-y: auto; scrollbar-gutter: stable; min-width: 0; padding: 0 18px 16px; }
    #app { min-height: 100%; }
  </style>
</head>
<body>
  <script nonce="${v.nonce}">
    console.log('[TraceRoost] HTML received', Date.now());
    window.__INITIAL_TOOL_CALLS__ = {};
    window.__INITIAL_SESSION_SUMMARY__ = ${v.sessionSummaryJson};
    window.__INITIAL_SESSION_REV__ = ${v.sessionRev};
    window.__INITIAL_COLLECTOR_CONFLICT__ = ${v.collectorConflictJson};
    window.__INITIAL_LOG_INGEST__ = ${v.logIngestJson};
    window.__STANDALONE__ = true;
    window.__VERSION__ = ${JSON.stringify(v.packageVersion)};

    // ── Client-side search support ────────────────────────────────────────────
    var __latestSessions__ = (window.__INITIAL_SESSION_SUMMARY__ && window.__INITIAL_SESSION_SUMMARY__.sessions) || [];
    // Follows the same base/rev protocol as App.tsx's 'update' handler: a frame whose base isn't
    // the revision held here is skipped — the dashboard asks for the full update that fixes both.
    var __latestRev__ = window.__INITIAL_SESSION_REV__;
    window.addEventListener('message', function(e) {
      var d = e.data;
      if (!d || d.type !== 'update') return;
      if (d.sessionSummary !== undefined) {
        if (d.sessionSummary && d.sessionSummary.sessions) __latestSessions__ = d.sessionSummary.sessions;
        __latestRev__ = d.rev;
      } else if (d.base !== undefined && d.base !== __latestRev__) {
        return;
      } else if (d.sessionDelta) {
        var byId = new Map();
        __latestSessions__.forEach(function(s) { byId.set(s.sessionId, s); });
        d.sessionDelta.upserts.forEach(function(s) { byId.set(s.sessionId, s); });
        var order = d.sessionDelta.order || __latestSessions__.map(function(s) { return s.sessionId; });
        var next = [];
        for (var i = 0; i < order.length; i++) {
          if (!byId.has(order[i])) return;
          next.push(byId.get(order[i]));
        }
        __latestSessions__ = next;
        __latestRev__ = d.rev;
      } else if (d.rev !== undefined) {
        __latestRev__ = d.rev;
      }
    });

    var _toastTimer;
    function showToast(msg) {
      var el = document.getElementById('sa-toast');
      if (!el) { el = document.createElement('div'); el.id = 'sa-toast'; document.body.appendChild(el); }
      el.textContent = msg;
      el.classList.add('visible');
      clearTimeout(_toastTimer);
      _toastTimer = setTimeout(function() { el.classList.remove('visible'); }, 3000);
    }

    // CSV/Markdown export helpers — mirrors src/exportFormats.ts. Kept as hand-written vanilla JS
    // (not compiled from TS) because this whole block is embedded directly into the served HTML's
    // inline script block, matching the rest of this file's acquireVsCodeApi polyfill.
    function csvCell(value) {
      return '"' + String(value).replace(/"/g, '""') + '"';
    }
    function joinList(items) {
      return (items || []).join('; ');
    }
    function joinToolCounts(counts) {
      var parts = [];
      for (var tool in (counts || {})) { parts.push(tool + ':' + counts[tool]); }
      return parts.join('; ');
    }
    function joinLoopSignals(signals) {
      return (signals || []).map(function(s) { return s.type + '(' + s.severity + ')'; }).join('; ');
    }
    var CSV_HEADERS = [
      'Session ID', 'Trace ID', 'Source', 'Data Source', 'Model', 'Models', 'Start Time', 'Duration (ms)', 'Turns',
      'Tool Calls', 'Input Tokens', 'Output Tokens', 'Cache Read Tokens', 'Cache Create Tokens',
      'Cache Hit Rate', 'Errors', 'Outcome', 'Tool Counts', 'Files Read', 'Files Changed',
      'Loop Signals', 'User Request'
    ];
    function toCsv(sessions) {
      var rows = sessions.map(function(s) {
        return [
          s.sessionId, s.traceId, s.source, s.dataSource || 'otel', s.model, joinList(s.models), s.startTime,
          String(s.durationMs), String(s.turns), String(s.totalToolCalls), String(s.inputTokens),
          String(s.outputTokens), String(s.cacheReadTokens), String(s.cacheCreateTokens),
          (s.cacheHitRate || 0).toFixed(4), String(s.errors), s.outcome,
          joinToolCounts(s.toolCounts), joinList(s.filesRead), joinList(s.filesChanged),
          joinLoopSignals(s.loopSignals), s.userRequest || ''
        ];
      });
      var allRows = [CSV_HEADERS].concat(rows);
      return allRows.map(function(row) { return row.map(csvCell).join(','); }).join('\\r\\n') + '\\r\\n';
    }
    function mdEscape(text) {
      return String(text).replace(/\\|/g, '\\\\|');
    }
    function toMarkdown(sessions) {
      var parts = ['# TraceRoost Session Export', '', sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ', exported ' + new Date().toISOString(), ''];
      sessions.forEach(function(s) {
        parts.push('## ' + (s.model || 'unknown model') + ' — ' + (s.startTime || 'unknown time'));
        parts.push('');
        parts.push('- **Session ID:** ' + s.sessionId);
        parts.push('- **Source:** ' + s.source + ' (' + (s.dataSource === 'log' ? 'log file' : 'OTEL') + ')');
        if (s.models && s.models.length > 1) parts.push('- **Models used:** ' + joinList(s.models));
        parts.push('- **Duration:** ' + s.durationMs + 'ms');
        parts.push('- **Turns:** ' + s.turns + ' · **Tool calls:** ' + s.totalToolCalls + ' · **Errors:** ' + s.errors);
        parts.push('- **Tokens:** ' + s.inputTokens.toLocaleString() + ' in / ' + s.outputTokens.toLocaleString() + ' out '
          + '(cache read ' + s.cacheReadTokens.toLocaleString() + ', cache write ' + s.cacheCreateTokens.toLocaleString() + ', '
          + ((s.cacheHitRate || 0) * 100).toFixed(1) + '% hit rate)');
        parts.push('- **Outcome:** ' + s.outcome);
        if (s.toolCounts && Object.keys(s.toolCounts).length > 0) {
          parts.push('- **Tool counts:** ' + joinToolCounts(s.toolCounts));
        }
        if (s.loopSignals && s.loopSignals.length > 0) {
          parts.push('- **Loop signals:** ' + joinLoopSignals(s.loopSignals));
        }
        if (s.filesRead && s.filesRead.length > 0) {
          parts.push('', '**Files read:**', '');
          s.filesRead.forEach(function(f) { parts.push('- \`' + mdEscape(f) + '\`'); });
        }
        if (s.filesChanged && s.filesChanged.length > 0) {
          parts.push('', '**Files changed:**', '');
          s.filesChanged.forEach(function(f) { parts.push('- \`' + mdEscape(f) + '\`'); });
        }
        if (s.userRequest) {
          parts.push('', '**Prompt:**', '', '> ' + mdEscape(s.userRequest).replace(/\\n/g, '\\n> '));
        }
        parts.push('', '---', '');
      });
      return parts.join('\\n');
    }
    function serializeExport(sessions, format) {
      if (format === 'csv') return toCsv(sessions);
      if (format === 'markdown') return toMarkdown(sessions);
      return JSON.stringify(sessions, null, 2);
    }
    function exportMimeType(format) {
      return format === 'csv' ? 'text/csv' : format === 'markdown' ? 'text/markdown' : 'application/json';
    }
    function exportFileExtension(format) {
      return format === 'csv' ? 'csv' : format === 'markdown' ? 'md' : 'json';
    }

    function getNotifContainer() {
      var el = document.getElementById('sa-notif-container');
      if (!el) {
        el = document.createElement('div');
        el.id = 'sa-notif-container';
        el.style.cssText = 'position:fixed;bottom:20px;right:16px;z-index:9998;display:flex;flex-direction:column;gap:8px;max-width:320px;';
        document.body.appendChild(el);
      }
      return el;
    }

    // showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs)
    // secondaryAction: { label: string, onClick: function } | null — rendered before Copy Prompt
    function showActionNotification(label, prompt, color, preview, secondaryAction, dismissMs) {
      color = color || '#f6a623';
      var container = getNotifContainer();
      var notif = document.createElement('div');
      notif.style.cssText = 'background:#252526;border:1px solid #3e3e42;border-left:3px solid ' + color + ';border-radius:4px;padding:10px 12px;font-size:12px;color:#ccc;box-shadow:0 2px 8px rgba(0,0,0,0.4);';

      var header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:6px;';

      var labelEl = document.createElement('span');
      labelEl.style.cssText = 'font-weight:600;color:' + color + ';line-height:1.3;';
      labelEl.textContent = label;

      var closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:none;border:none;color:#888;cursor:pointer;font-size:16px;padding:0;line-height:1;flex-shrink:0;';
      closeBtn.onclick = function() { notif.remove(); };

      header.appendChild(labelEl);
      header.appendChild(closeBtn);
      notif.appendChild(header);

      if (preview) {
        var previewEl = document.createElement('div');
        previewEl.style.cssText = 'font-size:11px;color:#999;margin-bottom:8px;line-height:1.4;max-height:56px;overflow:hidden;';
        previewEl.textContent = preview;
        notif.appendChild(previewEl);
      }

      var actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

      if (secondaryAction) {
        var secBtn = document.createElement('button');
        secBtn.textContent = secondaryAction.label;
        secBtn.style.cssText = 'background:none;border:1px solid #555;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px;padding:4px 10px;';
        secBtn.onclick = function() { secondaryAction.onClick(); notif.remove(); };
        actions.appendChild(secBtn);
      }

      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy Prompt';
      copyBtn.style.cssText = 'background:none;border:1px solid ' + color + ';border-radius:3px;color:' + color + ';cursor:pointer;font-size:11px;padding:4px 10px;';
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(prompt).then(function() {
          copyBtn.textContent = 'Copied!';
          copyBtn.style.borderColor = '#56D364';
          copyBtn.style.color = '#56D364';
          setTimeout(function() { notif.remove(); }, 1500);
        }).catch(function() {
          showToast('Could not copy — check browser clipboard permissions');
        });
      };
      actions.appendChild(copyBtn);

      notif.appendChild(actions);
      container.appendChild(notif);
      setTimeout(function() { notif.remove(); }, dismissMs || 30000);
    }

    var INSTRUCTION_ROUTES = {
      getInstructionFiles:          { path: '/api/instruction-files', get: true },
      getAppliedSuggestions:        { path: '/api/instructions/applied', get: true },
      getDismissedSuggestions:      { path: '/api/instructions/dismissed', get: true },
      applyInstructionSuggestion:   { path: '/api/instructions/apply' },
      dismissInstructionSuggestion: { path: '/api/instructions/dismiss' },
      removeInstructionSuggestion:  { path: '/api/instructions/remove' },
    };

    window.acquireVsCodeApi = function() {
      return {
        getState: function() { return null; },
        setState: function() {},
        postMessage: function(msg) {
          if (msg.type === 'requestFullUpdate') {
            _requestFullUpdate();
          }${ORG_FETCH_SHIM}
          if (msg.type === 'confirmClear') {
            if (confirm('Clear all TraceRoost data? OTEL trace data is deleted permanently. TraceRoost log cache is cleared and will be rebuilt from your local agent log files (the log files themselves are not deleted).')) {
              fetch('/api/clear', { method: 'POST' });
              window.dispatchEvent(new MessageEvent('message', { data: { type: 'clearAll' } }));
            }
          } else if (msg.type === 'clearAll') {
            fetch('/api/clear', { method: 'POST' });
          } else if (Object.prototype.hasOwnProperty.call(INSTRUCTION_ROUTES, msg.type)) {
            // Instructions tab — answered by the same messages dashboardPanel.ts posts back
            // (standalone/instructionActions.ts); an error is what the extension would show.
            var route = INSTRUCTION_ROUTES[msg.type];
            (route.get
              ? fetch(route.path + '?workspace=' + encodeURIComponent(msg.workspace || ''))
              : fetch(route.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
            ).then(function(r) { return r.json(); }).then(function(data) {
              (data.messages || []).forEach(function(m) {
                window.dispatchEvent(new MessageEvent('message', { data: m }));
              });
              if (data.error) showToast(data.error);
            }).catch(function() {
              showToast('TraceRoost: instruction file request failed');
            });
          } else if (msg.type === 'automation' && msg.prompt) {
            // Build full prompt matching VS Code format: [label] + session ID + body
            var sessionLine = msg.sessionId ? 'Trace ID: ' + msg.sessionId + '\\n' : '';
            var autoFull = '[' + (msg.label || 'Automation') + ']\\n\\n' + sessionLine + msg.prompt;
            var autoPreview = msg.prompt.length > 160 ? msg.prompt.slice(0, 160) + '…' : msg.prompt;
            var autoLabel = 'Automation: ' + (msg.label || 'Automation');
            var viewAutomations = {
              label: 'View Automations',
              onClick: function() {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'settings-automation' } }));
              }
            };
            if (msg.writePromptsFile) {
              fetch('/api/write-prompts-file', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent: msg.agent, label: msg.label, prompt: autoFull })
              }).then(function(r) {
                if (!r.ok) throw new Error('write failed');
                return r.json();
              }).then(function(data) {
                showToast('Prompt written to ' + (data.path || data.filename));
              }).catch(function() {
                showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
              });
            } else {
              showActionNotification(autoLabel, autoFull, '#f6a623', autoPreview, viewAutomations, 30000);
            }
          } else if (msg.type === 'askAI' && msg.prompt) {
            navigator.clipboard.writeText(msg.prompt).then(function() {
              showToast('Prompt copied to clipboard');
            }).catch(function() {
              showToast('Could not copy — check browser clipboard permissions');
            });
          } else if (msg.type === 'exportSessionData' || msg.type === 'exportSessionDataRedacted') {
            var redact = msg.type === 'exportSessionDataRedacted';
            var exportIds = Array.isArray(msg.sessionIds) ? new Set(msg.sessionIds) : null;
            var exportSessions = exportIds
              ? (__latestSessions__ || []).filter(function(s) { return exportIds.has(s.sessionId); })
              : (__latestSessions__ || []);
            var exportable = exportSessions.map(function(s) {
              return {
                sessionId:         s.sessionId,
                traceId:           s.traceId,
                source:            s.source,
                dataSource:        s.dataSource || 'otel',
                model:             s.model,
                models:            s.models || [s.model],
                startTime:         s.startTime,
                durationMs:        s.durationMs,
                turns:             s.totalLlmCalls,
                totalToolCalls:    s.totalToolCalls,
                inputTokens:       s.inputTokens,
                outputTokens:      s.outputTokens,
                cacheReadTokens:   s.cacheReadTokens,
                cacheCreateTokens: s.cacheCreateTokens,
                cacheHitRate:      s.cacheHitRate,
                errors:            s.errors,
                outcome:           s.outcome,
                toolCounts:        s.toolCounts,
                filesRead:    redact ? (s.filesRead    || []).map(function() { return '[redacted]'; }) : s.filesRead,
                filesChanged: redact ? (s.filesChanged || []).map(function() { return '[redacted]'; }) : s.filesChanged,
                loopSignals:  s.loopSignals,
                language:     s.language || null,
                languageSecondary: s.languageSecondary || null,
                filesChangedCount: s.filesChangedCount == null ? null : s.filesChangedCount,
                linesAdded:   s.linesAdded == null ? null : s.linesAdded,
                linesRemoved: s.linesRemoved == null ? null : s.linesRemoved,
                userRequest:  redact ? '[redacted]' : (s.userRequest || null),
              };
            });
            var format = (msg.format === 'csv' || msg.format === 'markdown') ? msg.format : 'json';
            var now = new Date();
            var pad = function(n) { return String(n).padStart(2, '0'); };
            var ts = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
                     '_' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
            var filename = (redact ? 'export_redacted' : 'export') + '_sessions_' + ts + '.' + exportFileExtension(format);
            var blob = new Blob([serializeExport(exportable, format)], { type: exportMimeType(format) });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            URL.revokeObjectURL(url);
            showToast('Downloaded ' + filename);
          } else if (msg.type === 'openSidebar' || msg.type === 'closeSidebar') {
            window.dispatchEvent(new CustomEvent('traceroost:sidebar', { detail: { open: msg.type === 'openSidebar' } }));
          } else if (msg.type === 'searchSessions' && msg.query) {
            var q = msg.query;
            var filtered = __latestSessions__.filter(function(s) {
              if (q.text) {
                var t = q.text.toLowerCase();
                if (!(s.userRequest || '').toLowerCase().includes(t) && !(s.model || '').toLowerCase().includes(t)) return false;
              }
              if (q.source && s.source !== q.source) return false;
              if (q.since) { var ms = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms < q.since) return false; }
              if (q.until) { var ms2 = s.startTime ? new Date(s.startTime).getTime() : 0; if (ms2 > q.until) return false; }
              return true;
            });
            var dir = q.orderDir === 'ASC' ? 1 : -1;
            filtered.sort(function(a, b) {
              if (q.orderBy === 'start_time') return dir * (new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
              if (q.orderBy === 'total_tokens') return dir * ((a.inputTokens + a.outputTokens) - (b.inputTokens + b.outputTokens));
              if (q.orderBy === 'duration_ms') return dir * (a.durationMs - b.durationMs);
              if (q.orderBy === 'errors') return dir * (a.errors - b.errors);
              if (q.orderBy === 'cost_usd') return 0;
              return 0;
            });
            var offset = q.offset || 0; var limit = q.limit || 50;
            var page = filtered.slice(offset, offset + limit);
            setTimeout(function() {
              window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'searchResults', sessions: page, totalCount: filtered.length, offset: offset, context: msg.context || 'search' }
              }));
            }, 0);
          } else if (msg.type === 'alert' && msg.label) {
            var alertColor = msg.severity === 'error' ? '#f44747' : msg.severity === 'info' ? '#4fc3f7' : '#f6a623';
            var alertPrompt = [
              "An alert was triggered in my AI coding trace. Please explain what's happening and how I should respond.",
              '',
              'Alert: ' + msg.label,
            ].concat(msg.detail ? ['Detail: ' + msg.detail] : []).join('\\n');
            showActionNotification(
              'Alert: ' + msg.label,
              alertPrompt,
              alertColor,
              msg.detail || null,
              {
                label: 'View Alerts',
                onClick: function() {
                  window.dispatchEvent(new MessageEvent('message', { data: { type: 'switchTab', tab: 'alerts' } }));
                }
              },
              30000
            );
          } else if (msg.type === 'loadSessionDetail' && msg.sessionId) {
            fetch('/api/timeline/' + encodeURIComponent(msg.sessionId))
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'sessionDetail', sessionId: msg.sessionId, timeline: data.timeline || [] }
                }));
              })
              .catch(function(e) { console.warn('[TraceRoost] Timeline fetch failed', e); });
          } else if (msg.type === 'getGitOutcome' && msg.sessionId) {
            fetch('/api/git-outcome', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                sessionId: msg.sessionId,
                workspace: msg.workspace || '',
                filesChanged: msg.filesChanged || [],
                endTime: msg.endTime || '',
              }),
            })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                // A deferred reply (session still inside its active-session grace window): no git
                // classification ran, so dispatch a distinct message rather than 'gitOutcome' —
                // App.tsx uses it to keep the Outcome filter's pending-count spinner from counting
                // this session (deferredGitOutcomeSessionIds in state.ts) without caching a
                // premature answer. It'll resolve for real unsolicited over SSE once the grace
                // timer revisits it, or on the next sessions refresh.
                if (data.deferred) {
                  window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'gitOutcomeDeferred', sessionId: data.sessionId }
                  }));
                  return;
                }
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'gitOutcome', sessionId: data.sessionId, outcome: data.outcome, riskSignals: data.riskSignals, temperedLoopSignals: data.temperedLoopSignals, revision: data.revision }
                }));
              })
              .catch(function(e) {
                console.warn('[TraceRoost] Git outcome fetch failed', e);
                // Still dispatch a reply (as "not applicable") — the Outcome filter's pending
                // count only ever counts down on a 'gitOutcome' message, so a request that only
                // logs and never replies leaves that session's spinner stuck forever.
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'gitOutcome', sessionId: msg.sessionId, outcome: null, riskSignals: [], temperedLoopSignals: null }
                }));
              });
          } else if (msg.type === 'getGitOutcomes' && Array.isArray(msg.sessionIds)) {
            fetch('/api/git-outcomes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionIds: msg.sessionIds }),
            })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'gitOutcomeCacheBatch', outcomes: data.outcomes || {} }
                }));
              })
              .catch(function(e) {
                console.warn('[TraceRoost] Batched git outcome fetch failed', e);
                (msg.sessionIds || []).forEach(function(sessionId) {
                  window.dispatchEvent(new MessageEvent('message', {
                    data: { type: 'gitOutcome', sessionId: sessionId, outcome: null, riskSignals: [], temperedLoopSignals: null }
                  }));
                });
              });
          } else if (msg.type === 'getRepoHash' && msg.workspace) {
            fetch('/api/repo-hash', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ workspace: msg.workspace }),
            })
              .then(function(r) { return r.json(); })
              .then(function(data) {
                window.dispatchEvent(new MessageEvent('message', {
                  data: { type: 'repoHash', workspace: data.workspace, name: data.name, hash: data.hash, githubUrl: data.githubUrl }
                }));
              })
              .catch(function(e) { console.warn('[TraceRoost] Repo hash fetch failed', e); });
          } else if (msg.type === 'reconfigureOtel') {
            fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'reconfigureOtel' }) })
              .then(function(r) { return r.json(); })
              .then(function(results) {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'reconfigureOtelResult', results: results } }));
              })
              .catch(function(e) {
                window.dispatchEvent(new MessageEvent('message', { data: { type: 'reconfigureOtelResult', results: { error: String(e) } } }));
              });
          }
        }
      };
    };

    // SSE → dispatch as window message (picked up by Preact app AND sidebar handler below)
    // Falls back to polling /api/summary every 2s if EventSource fails (e.g. Safari private mode).
    //
    // Held until the dashboard says it's listening (App.tsx calls __trDashboardListening from the
    // effect that adds its message handler). The stream's first frames — the update, the action
    // log, the plan-limit snapshot — arrive before dashboard.js has even loaded, and the plan
    // snapshot is only re-sent when it changes, so dispatching them straight away lost them and
    // left Plan limits hidden on an idle dashboard.
    var _dashboardListening = false;
    var _pendingFrames = [];
    function _deliver(data) {
      if (_dashboardListening) window.dispatchEvent(new MessageEvent('message', { data: data }));
      else _pendingFrames.push(data);
    }
    window.__trDashboardListening = function() {
      if (_dashboardListening) return;
      _dashboardListening = true;
      var q = _pendingFrames;
      _pendingFrames = [];
      for (var i = 0; i < q.length; i++) window.dispatchEvent(new MessageEvent('message', { data: q[i] }));
    };
    // Never hold them forever: if dashboard.js fails to load, the sidebar handler still gets them.
    setTimeout(window.__trDashboardListening, 10000);
    var _sseOk = false;
    var _pollTimer = null;
    function _startPolling() {
      if (_pollTimer) return;
      console.warn('[TraceRoost] SSE unavailable — falling back to polling');
      _pollTimer = setInterval(function() {
        fetch('/api/summary')
          .then(function(r) { return r.json(); })
          .then(function(summary) {
            _deliver({ type: 'update', sessionSummary: summary });
          })
          .catch(function(e) { console.warn('[TraceRoost] Poll failed', e); });
      }, 2000);
    }
    // Names this tab's stream so a full update can be requested down it (/api/sse-resync). The
    // rev is what the inlined HTML holds — a (re)connection at any other revision starts with a
    // full update.
    var _sseClientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var _es;
    function _openEvents(rev) {
      _es = new EventSource('/events?client=' + _sseClientId + (rev !== undefined ? '&rev=' + rev : ''));
      _es.onopen = function() {
        console.log('[TraceRoost] SSE connected', Date.now());
        _sseOk = true;
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
      };
      _es.onmessage = function(e) {
        _deliver(JSON.parse(e.data));
      };
      _es.onerror = function() {
        if (!_sseOk) {
          // Never connected — start polling immediately
          _startPolling();
        }
        // If it was connected before, browser will auto-reconnect; don't start polling yet
      };
    }
    function _requestFullUpdate() {
      if (!_es) return;
      fetch('/api/sse-resync?client=' + _sseClientId, { method: 'POST' })
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
        .catch(function() {
          // Stream not (yet) known to the server — reopen it without a revision, which always
          // starts with a full update.
          _es.close();
          _openEvents(undefined);
        });
    }
    _openEvents(window.__INITIAL_SESSION_REV__);
  </script>

  <div id="sa-wrap">
    <!-- ── Sidebar (live session monitor) ────────────────────────────────── -->
    <div id="sa-sidebar" class="sa-collapsed">
      <div style="flex-shrink:0;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border)" title="Updates live as the current agent trace progresses">
        <span style="font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);font-weight:600">Live &middot; Current Trace Activity</span>
      </div>
      <div style="flex:1;overflow-y:auto;padding:8px 8px 8px;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <div id="sb-plan-meters" class="sb-plan-meters" style="display:none" title="Plan limits — open Analytics"></div>
        <!-- Status row -->
        <div class="sb-card" style="margin-bottom:6px">
          <div class="sb-row" style="margin-bottom:2px">
            <span class="sb-dot idle" id="sb-dot"></span>
            <span class="sb-status" id="sb-status-text">Idle</span>
            <span style="flex:1"></span>
            <span id="sb-agent" class="sb-muted" style="display:flex;align-items:center"></span>
            <span id="sb-dur" class="sb-muted"></span>
          </div>
          <div id="sb-prompt" class="sb-prompt"></div>
          <div id="sb-model" class="sb-model"></div>
          <span id="sb-ago" class="sb-muted" style="font-size:10px"></span>
        </div>

        <!-- Session block (hidden when no sessions) -->
        <div id="sb-session-block" style="display:none">

          <!-- Key counters (shown first) -->
          <div class="sb-card">
            <div class="sb-counters">
              <div>
                <div class="sb-counter-val" id="sb-turns">—</div>
                <div class="sb-counter-key">Turns</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-tools">—</div>
                <div class="sb-counter-key">Tools</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-errors">—</div>
                <div class="sb-counter-key">Errors</div>
              </div>
              <div>
                <div class="sb-counter-val" id="sb-cache">—</div>
                <div class="sb-counter-key">Cache</div>
              </div>
            </div>
          </div>

          <!-- Context growth sparkline -->
          <div class="sb-card">
            <div class="sb-section-label">Context Growth</div>
            <canvas id="sb-sparkline"></canvas>
            <div id="sb-turn-label" class="sb-turn-label"></div>
            <div id="sb-sparkline-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
          </div>

          <!-- Token breakdown (input / output) -->
          <div class="sb-card" id="sb-tokens-card">
            <div class="sb-section-label">Tokens</div>
            <div id="sb-token-bars" style="margin-top:4px"></div>
            <div id="sb-token-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic;padding:2px 0">Waiting for data…</div>
          </div>

          <!-- Estimated cost -->
          <div class="sb-card" id="sb-cost-card">
            <div class="sb-section-label">Estimated Cost</div>
            <div id="sb-cost-val" style="font-size:16px;font-weight:700;color:var(--vscode-charts-green,#81c784)">—</div>
          </div>

          <!-- Burn rate -->
          <div class="sb-card" id="sb-burn-row">
            <div class="sb-section-label">Burn Rate</div>
            <div id="sb-burn" class="sb-burn"></div>
            <div id="sb-burn-waiting" class="sb-muted" style="display:none;font-size:10px;font-style:italic">Waiting for data…</div>
          </div>

          <!-- Plan limit (subscription 5-hour / weekly windows) — rendered by sidebarWebview.ts, absent when there's no data -->
          <div class="sb-card" id="sb-plan-limit" style="display:none"></div>

        </div>

        <!-- Empty state (shown by render() when currentSession is null) -->
        <div id="sb-empty" class="sb-muted" style="text-align:center;padding:24px 0;font-size:11px;display:none">
          No traces recorded yet
        </div>


      </div>

      <!-- Footer -->
      <div class="sb-footer">
        <span><span id="sb-session-count">0</span> traces stored</span>
      </div>
    </div>

    <!-- ── Main dashboard ─────────────────────────────────────────────────── -->
    <div id="sa-main">
      <div id="app"></div>
    </div>
  </div>

  <script nonce="${v.nonce}">
    console.log('[TraceRoost] Inline setup done', Date.now());
    window.onerror = function(msg, src, line, col, err) {
      console.error('[TraceRoost] JS error:', msg, src + ':' + line + ':' + col, err);
      var app = document.getElementById('app');
      if (app) {
        app.style.cssText = 'padding:20px;color:red;font-family:monospace;white-space:pre-wrap';
        app.textContent = 'JS ERROR: ' + msg + ' | At: ' + src + ':' + line + ':' + col + ' | ' + (err ? err.stack : '');
      }
    };
  </script>

  <script nonce="${v.nonce}" src="/dashboard.js"></script>
  <script nonce="${v.nonce}">console.log('[TraceRoost] dashboard.js loaded', Date.now());</script>

  <script nonce="${v.nonce}">
    // Sidebar collapse driven by dashboard toggle
    var _sidebarEl = document.getElementById('sa-sidebar');
    window.addEventListener('traceroost:sidebar', function(e) {
      _sidebarEl.classList.toggle('sa-collapsed', !e.detail.open);
    });
</script>
  <script nonce="${v.nonce}">var __SIDEBAR_INIT__ = ${v.sidebarInitJson};</script>
  <script nonce="${v.nonce}" src="/sidebar.js"></script>
</body>
</html>`
}
