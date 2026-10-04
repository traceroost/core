/**
 * End-to-end check of the extension as it runs inside a real VS Code — the runtime half of
 * runbooks/WINDOWS_VALIDATION.md, automated. Runs on Windows, macOS and Linux via
 * tests/e2e/vscode/run.mjs, against either the dev build (--extensionDevelopmentPath) or a packaged
 * VSIX installed into a fresh --extensions-dir. The runner isolates everything: a temp HOME /
 * USERPROFILE (with a fixture Claude Code transcript already under ~/.claude/projects), a temp
 * --user-data-dir with free OTLP/MCP ports in its settings.json, and a fixture git repo.
 */
import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import * as vscode from 'vscode'
import {
  loadConfig, waitFor, httpRequest, mcpCall, globalStorageDir, queryDb, outputChannelText, outputChannelErrors,
  samePath, sleep, freshTrace, type ItConfig, type Row,
} from './support'

suite('TraceRoost extension (end to end)', () => {
  let cfg: ItConfig
  let ext: vscode.Extension<unknown>
  let dbPath: string

  suiteSetup(async () => {
    cfg = loadConfig()
    const found = vscode.extensions.getExtension(cfg.extensionId)
    assert.ok(found, `extension ${cfg.extensionId} is installed (have: ${vscode.extensions.all.filter(e => !e.id.startsWith('vscode.')).map(e => e.id).join(', ')})`)
    ext = found
    dbPath = path.join(globalStorageDir(cfg, ext), 'traceroost.db')
  })

  test('activates (onStartupFinished) without errors in its Output channel', async () => {
    await waitFor('activation', async () => { if (!ext.isActive) await ext.activate(); return ext.isActive }, 60_000)
    const text = await waitFor('"TraceRoost database initialized." in the Output channel log', () => {
      const t = outputChannelText(cfg)
      return t.includes('TraceRoost database initialized.') ? t : undefined
    }, 60_000)
    assert.ok(text.includes(`TraceRoost activating… (v${ext.packageJSON.version})`), 'activation banner logged')
    assert.deepStrictEqual(outputChannelErrors(text), [], 'no failures logged during activation')
  })

  test('registers every contributed command (and no Org commands in the core edition)', async () => {
    const contributed = (ext.packageJSON.contributes?.commands ?? []) as Array<{ command: string }>
    assert.ok(contributed.length >= 5, 'manifest contributes commands')
    const registered = new Set(await vscode.commands.getCommands(true))
    const missing = contributed.map(c => c.command).filter(c => !registered.has(c))
    assert.deepStrictEqual(missing, [], 'every contributed command is registered')
    const org = [...registered].filter(c => c.startsWith('traceRoost.org'))
    if (cfg.edition === 'core') assert.deepStrictEqual(org, [], 'core edition registers no Org commands')
    else assert.ok(org.length >= 3, 'full edition registers the Org commands')
  })

  test('auto-configures Claude Code and Codex under the (temp) home directory', async () => {
    const endpoint = `http://localhost:${cfg.otlpPort}`
    const settings = await waitFor('~/.claude/settings.json', () => {
      const s = JSON.parse(fs.readFileSync(path.join(cfg.home, '.claude', 'settings.json'), 'utf8')) as { env?: Record<string, string> }
      return s.env?.OTEL_EXPORTER_OTLP_ENDPOINT === endpoint ? s : undefined
    }, 30_000)
    assert.strictEqual(settings.env?.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
    const toml = fs.readFileSync(path.join(cfg.home, '.codex', 'config.toml'), 'utf8')
    assert.ok(toml.includes(`endpoint = "${endpoint}"`), `config.toml points Codex at ${endpoint}`)
  })

  test('ingests a Claude Code session from OTLP and from its transcript, as one session with workspace/model/tokens/cost', async () => {
    const res = await httpRequest('POST', `http://127.0.0.1:${cfg.otlpPort}/v1/traces`, cfg.fixture.otlp)
    assert.strictEqual(res.status, 200, `collector accepted the fixture trace: ${res.text}`)

    // The transcript was on disk before VS Code started, so the activation-time log scan has already
    // picked it up (or is about to). The OTEL card joins its transcript turn, so both are one row
    // under the turn's key, and the higher source rank keeps it OTEL (stable trace identity).
    const rows = await waitFor('the fixture session in the sql.js database on disk', async () => {
      const r = await queryDb(ext.extensionPath, dbPath,
        `SELECT session_id, source, data_source, workspace, model, input_tokens, output_tokens, cost_usd, conversation_id, files_changed
           FROM sessions WHERE source = 'claude_code' AND (conversation_id = ? OR session_id = ? OR session_id LIKE ?)`,
        [cfg.fixture.sessionId, cfg.fixture.sessionId, `${cfg.fixture.sessionId}#%`])
      return r.some(x => x.session_id === cfg.fixture.turnKey && x.data_source === 'otel') && r.length === 1 ? r : undefined
    }, 90_000).catch(async e => {
      const all = await queryDb(ext.extensionPath, dbPath, 'SELECT session_id, source, data_source, workspace, conversation_id FROM sessions')
      throw new Error(`${e.message}\nsessions table: ${JSON.stringify(all, null, 1)}\n--- output ---\n${outputChannelText(cfg).slice(-3000)}`)
    })
    const row = rows[0] as Row
    assert.strictEqual(row.data_source, 'otel')
    assert.strictEqual(row.conversation_id, cfg.fixture.sessionId, 'conversation id links the OTEL card to the transcript')
    assert.ok(samePath(String(row.workspace), cfg.repo), `workspace is the fixture repo (got ${row.workspace}, want ${cfg.repo})`)
    assert.strictEqual(row.model, cfg.fixture.model)
    assert.ok(Number(row.input_tokens) > 0 && Number(row.output_tokens) > 0, 'tokens recorded')
    const changed = JSON.parse(String(row.files_changed)) as string[]
    assert.ok(changed.some(f => samePath(f, cfg.fixture.file)), `files_changed has ${cfg.fixture.file}: ${row.files_changed}`)

    const recent = await mcpCall(cfg.mcpPort, 'get_recent_sessions', { limit: 50 }) as Array<{ sessionId: string; cost_usd: number; model: string }>
    const viaMcp = recent.find(r => r.sessionId === cfg.fixture.turnKey)
    assert.ok(viaMcp, 'the MCP server lists the session')
    assert.ok(viaMcp.cost_usd > 0, `MCP reports a cost (got ${viaMcp.cost_usd})`)
    assert.ok(!recent.some(r => r.sessionId === cfg.fixture.sessionId), 'the transcript card is not listed separately')
  })

  test('resolves a git outcome for the session in the fixture repo', async () => {
    // A new commit wakes the background reconciliation watcher on the repo's .git (3 s debounce;
    // it also re-polls every 60 s). Its result lives in the in-memory database until the next
    // save, which a fresh (new-id) trace post triggers — re-posting identical spans changes nothing.
    fs.writeFileSync(path.join(cfg.repo, 'later.txt'), 'later\n')
    execFileSync('git', ['add', '-A'], { cwd: cfg.repo })
    execFileSync('git', ['commit', '-q', '-m', 'later'], { cwd: cfg.repo })
    const outcome = await waitFor('a git_outcome row for the session', async () => {
      await httpRequest('POST', `http://127.0.0.1:${cfg.otlpPort}/v1/traces`, freshTrace(cfg.fixture.otlp))
      await sleep(2500)
      const r = await queryDb(ext.extensionPath, dbPath, 'SELECT overall, reason, repo_root FROM git_outcome WHERE session_id = ?', [cfg.fixture.turnKey])
      return r[0]
    }, 180_000, 5_000).catch(async e => {
      const outcomes = await queryDb(ext.extensionPath, dbPath, 'SELECT session_id, overall, reason, repo_root FROM git_outcome')
      const sessions = await queryDb(ext.extensionPath, dbPath, 'SELECT session_id, workspace, files_changed, start_time, duration_ms FROM sessions')
      throw new Error(`${e.message}\ngit_outcome: ${JSON.stringify(outcomes)}\nsessions: ${JSON.stringify(sessions)}\n--- output ---\n${outputChannelText(cfg).slice(-3000)}`)
    })
    assert.ok(['committed', 'merged'].includes(String(outcome.overall)), `outcome committed/merged (got ${outcome.overall}: ${outcome.reason})`)
    assert.ok(samePath(String(outcome.repo_root), cfg.repo), `outcome repo root is the fixture repo (got ${outcome.repo_root})`)
  })

  test('opens the dashboard webview panel', async () => {
    await vscode.commands.executeCommand('traceRoost.openDashboard')
    const tab = await waitFor('the TraceRoost Dashboard tab', () => vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .find(t => t.input instanceof vscode.TabInputWebview && /traceRoost\.fullDashboard$/.test(t.input.viewType)), 30_000)
    assert.strictEqual(tab.label, 'TraceRoost Dashboard')
    await sleep(3000) // let the webview boot and post its first messages
    assert.deepStrictEqual(outputChannelErrors(outputChannelText(cfg)), [], 'no failures logged while the dashboard loads')
  })

  test('storage stats and export work against the real storage directory', async () => {
    await vscode.commands.executeCommand('traceRoost.showStorageStats')
    const stats = await waitFor('storage stats in the Output channel', () => {
      const m = /Database:\s+[\d.]+ MB\s+\((\d+) sessions/.exec(outputChannelText(cfg))
      return m ? m : undefined
    }, 20_000)
    assert.ok(Number(stats[1]) >= 1, `storage stats count the session (${stats[0]})`)

    const dir = globalStorageDir(cfg, ext)
    const before = new Set(fs.readdirSync(dir))
    await vscode.commands.executeCommand('traceRoost.exportData')
    const written = await waitFor('an export file in globalStorage', () =>
      fs.readdirSync(dir).filter(f => !before.has(f) && /^export_.*\.json$/.test(f)), 20_000)
    for (const f of written) {
      assert.ok(/^[A-Za-z0-9_.-]+$/.test(f), `export filename is portable (${f})`)
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as unknown
      assert.ok(parsed && typeof parsed === 'object', `${f} is JSON`)
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })

  test('saved its database file and owns it', async () => {
    assert.ok(fs.existsSync(dbPath), `${dbPath} exists`)
    assert.ok(fs.statSync(dbPath).size > 0, 'database file is non-empty')
    const owner = `${dbPath}.owner`
    assert.ok(fs.existsSync(owner), 'this window holds the database-owner lock')
    assert.strictEqual(parseInt(fs.readFileSync(owner, 'utf8'), 10), process.pid, 'the lock names this extension host')
  })
})
