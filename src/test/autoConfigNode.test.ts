import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { autoConfigureClaudeCode, autoConfigureCodex, autoConfigureCopilotStandalone, removeClaudeCodeSetup, removeCodexSetup, removeCopilotStandaloneSetup } from '../autoConfigNode'

suite('autoConfigNode', () => {
  let home: string
  let savedHome: string | undefined
  let savedUserProfile: string | undefined
  let savedCodexHome: string | undefined

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-autoconfig-test-'))
    savedHome = process.env.HOME
    savedUserProfile = process.env.USERPROFILE
    savedCodexHome = process.env.CODEX_HOME
    // os.homedir() reads HOME on POSIX but USERPROFILE on Windows — sandbox both.
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.CODEX_HOME
  })

  teardown(() => {
    if (savedHome === undefined) { delete process.env.HOME } else { process.env.HOME = savedHome }
    if (savedUserProfile === undefined) { delete process.env.USERPROFILE } else { process.env.USERPROFILE = savedUserProfile }
    if (savedCodexHome === undefined) { delete process.env.CODEX_HOME } else { process.env.CODEX_HOME = savedCodexHome }
    fs.rmSync(home, { recursive: true, force: true })
  })

  suite('autoConfigureClaudeCode', () => {
    const settingsPath = () => path.join(home, '.claude', 'settings.json')

    test('creates the settings file when it does not exist', async () => {
      const result = await autoConfigureClaudeCode(4318)
      assert.strictEqual(result.changed, true)
      assert.strictEqual(result.error, undefined)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.strictEqual(written.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')
      assert.strictEqual(fs.existsSync(settingsPath() + '.traceroost.bak'), false)
    })

    test('does not install a Stop hook', async () => {
      await autoConfigureClaudeCode(4318)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.strictEqual(written.hooks, undefined)
    })

    test('removes the legacy pending-prompt Stop hook but keeps the user\'s own hooks', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      const legacy = { type: 'command', command: 'f=$HOME/.traceroost/pending-prompt.txt; [ -f "$f" ] && cat "$f" && rm "$f"' }
      const mine = { type: 'command', command: 'say done' }
      fs.writeFileSync(settingsPath(), JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
        hooks: {
          Stop: [{ matcher: '', hooks: [legacy] }, { matcher: '', hooks: [mine, legacy] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [mine] }],
        },
      }))
      const result = await autoConfigureClaudeCode(4318)
      assert.strictEqual(result.changed, true)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.deepStrictEqual(written.hooks.Stop, [{ matcher: '', hooks: [mine] }])
      assert.deepStrictEqual(written.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [mine] }])
    })

    test('drops the hooks key entirely when the legacy Stop hook was the only hook', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      fs.writeFileSync(settingsPath(), JSON.stringify({
        hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'cat ~/.traceroost/pending-prompt.txt' }] }] },
      }))
      await autoConfigureClaudeCode(4318)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.strictEqual(written.hooks, undefined)
    })

    test('leaves an unparseable file byte-for-byte untouched and reports an error', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      const original = '{\n  // my comment\n  "model": "opus",\n}\n'
      fs.writeFileSync(settingsPath(), original)
      const result = await autoConfigureClaudeCode(4318)
      assert.strictEqual(result.changed, false)
      assert.match(result.error ?? '', /not valid JSON/)
      assert.strictEqual(fs.readFileSync(settingsPath(), 'utf-8'), original)
    })

    test('skips (does not recreate) a settings path that cannot be read', async () => {
      // A directory where the file should be → EISDIR, not ENOENT.
      fs.mkdirSync(settingsPath(), { recursive: true })
      const result = await autoConfigureClaudeCode(4318)
      assert.strictEqual(result.changed, false)
      assert.ok(result.error)
      assert.ok(fs.statSync(settingsPath()).isDirectory())
    })

    test('preserves existing keys and writes a one-time .bak of the original', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      const original = JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }, null, 2)
      fs.writeFileSync(settingsPath(), original)
      const result = await autoConfigureClaudeCode(4318)
      assert.strictEqual(result.changed, true)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.strictEqual(written.model, 'opus')
      assert.strictEqual(written.env.FOO, 'bar')
      assert.strictEqual(written.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1')
      assert.strictEqual(fs.readFileSync(settingsPath() + '.traceroost.bak', 'utf-8'), original)

      // A second change (port moved) must not replace the backup of the user's original.
      await autoConfigureClaudeCode(4319)
      assert.strictEqual(fs.readFileSync(settingsPath() + '.traceroost.bak', 'utf-8'), original)
      assert.deepStrictEqual(
        fs.readdirSync(path.dirname(settingsPath())).filter(f => f.endsWith('.tmp')), [],
        'no temp files left behind',
      )
    })

    // Prompt and tool-content logging next to the user's own endpoint would send that content to
    // their collector because of TraceRoost — so a file that exports elsewhere is not touched.
    for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']) {
      test(`leaves settings untouched when ${key} points at another collector`, async () => {
        fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
        const original = JSON.stringify({ env: { [key]: 'https://otel.example.com:4318', CLAUDE_CODE_ENABLE_TELEMETRY: '1' } })
        fs.writeFileSync(settingsPath(), original)
        const result = await autoConfigureClaudeCode(4318)
        assert.strictEqual(result.changed, false)
        assert.match(result.warning ?? '', /otel\.example\.com/)
        assert.strictEqual(fs.readFileSync(settingsPath(), 'utf-8'), original)
        assert.ok(!fs.existsSync(settingsPath() + '.traceroost.bak'))
      })
    }

    test('updates a loopback endpoint left by an earlier TraceRoost port', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      fs.writeFileSync(settingsPath(), JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4320' },
      }))
      await autoConfigureClaudeCode(4318)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.strictEqual(written.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4318')
    })
  })

  suite('autoConfigureCopilotStandalone', () => {
    const codeSettings = () => path.join(home, '.config', 'Code', 'User', 'settings.json')

    test('edits JSONC settings in place, keeping comments and trailing commas', async function () {
      if (process.platform !== 'linux') { this.skip() }
      fs.mkdirSync(path.dirname(codeSettings()), { recursive: true })
      const original = '{\n  // keep me\n  "editor.fontSize": 14,\n}\n'
      fs.writeFileSync(codeSettings(), original)

      const results = await autoConfigureCopilotStandalone(4318)
      assert.deepStrictEqual(results, [{ changed: true }])
      const text = fs.readFileSync(codeSettings(), 'utf-8')
      assert.ok(text.includes('// keep me'), text)
      assert.ok(text.includes('"editor.fontSize": 14'), text)
      assert.ok(text.includes('"github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318"'), text)
      assert.strictEqual(fs.readFileSync(codeSettings() + '.traceroost.bak', 'utf-8'), original)

      // Idempotent second run.
      assert.deepStrictEqual(await autoConfigureCopilotStandalone(4318), [{ changed: false }])
    })

    test('leaves settings untouched when otlpEndpoint points at another collector', async function () {
      if (process.platform !== 'linux') { this.skip() }
      fs.mkdirSync(path.dirname(codeSettings()), { recursive: true })
      // Telemetry off, own collector configured: turning it on would send Copilot telemetry there.
      const original = '{ "github.copilot.chat.otel.otlpEndpoint": "https://otel.example.com", "github.copilot.chat.otel.enabled": false }\n'
      fs.writeFileSync(codeSettings(), original)
      const [result] = await autoConfigureCopilotStandalone(4318)
      assert.strictEqual(result.changed, false)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      assert.strictEqual(fs.readFileSync(codeSettings(), 'utf-8'), original)
    })

    test('leaves a file it cannot parse untouched', async function () {
      if (process.platform !== 'linux') { this.skip() }
      fs.mkdirSync(path.dirname(codeSettings()), { recursive: true })
      const original = '{ "a": 1, oops }'
      fs.writeFileSync(codeSettings(), original)
      const [result] = await autoConfigureCopilotStandalone(4318)
      assert.strictEqual(result.changed, false)
      assert.match(result.error ?? '', /could not be parsed/)
      assert.strictEqual(fs.readFileSync(codeSettings(), 'utf-8'), original)
    })
  })

  suite('autoConfigureCodex', () => {
    const configPath = () => path.join(home, '.codex', 'config.toml')

    test('creates config.toml when missing', async () => {
      const result = await autoConfigureCodex(4318)
      assert.strictEqual(result.changed, true)
      const text = fs.readFileSync(configPath(), 'utf-8')
      assert.ok(text.startsWith('[otel]\n'))
      assert.ok(text.includes('endpoint = "http://localhost:4318"'))
    })

    test('reuses an [otel] header with a trailing comment instead of adding a second one', async () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(configPath(), 'model = "o3"\n\n[otel] # telemetry\nenvironment = "dev"\n')
      await autoConfigureCodex(4318)
      const text = fs.readFileSync(configPath(), 'utf-8')
      assert.strictEqual(text.match(/^\[otel\]/gm)?.length, 1, text)
      assert.ok(text.includes('environment = "dev"'))
    })

    test('replaces dotted exporter keys rather than duplicating the key', async () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      fs.writeFileSync(configPath(), [
        '[otel]',
        'exporter.otlp-http.endpoint = "http://localhost:9999"',
        'exporter.otlp-http.protocol = "binary"',
        '',
        '[profiles.x]',
        'model = "o3"',
        '',
      ].join('\n'))
      await autoConfigureCodex(4318)
      const text = fs.readFileSync(configPath(), 'utf-8')
      const exporterLines = text.split('\n').filter(l => /^\s*exporter\s*[=.]/.test(l))
      assert.strictEqual(exporterLines.length, 1, text)
      assert.ok(text.includes('[profiles.x]\nmodel = "o3"'))
      assert.ok(fs.existsSync(configPath() + '.traceroost.bak'))
    })

    test('leaves an [otel.exporter] sub-table layout untouched', async () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      const original = '[otel]\nlog_user_prompt = true\n\n[otel.exporter.otlp-http]\nendpoint = "http://x"\n'
      fs.writeFileSync(configPath(), original)
      const result = await autoConfigureCodex(4318)
      assert.strictEqual(result.changed, false)
      assert.ok(result.error)
      assert.strictEqual(fs.readFileSync(configPath(), 'utf-8'), original)
    })

    test('keeps an exporter already aimed at TraceRoost that carries an auth header', async () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      const withHeaders = 'exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json", headers = { "Authorization" = "Bearer t" } } }'
      fs.writeFileSync(configPath(), `[otel]\nlog_user_prompt = true\n${withHeaders}\n`)
      await autoConfigureCodex(4318)
      const text = fs.readFileSync(configPath(), 'utf-8')
      assert.ok(text.includes(withHeaders), text)
      assert.strictEqual(text.split('\n').filter(l => /^\s*exporter\s*[=.]/.test(l)).length, 1, text)
      assert.ok(text.includes('trace_exporter = '))
    })

    test('leaves [otel] untouched when an exporter points at another collector', async () => {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true })
      const own = 'exporter = { otlp-http = { endpoint = "https://otel.example.com/v1/logs", protocol = "binary" } }'
      const original = `[otel]\n${own}\n`
      fs.writeFileSync(configPath(), original)
      const result = await autoConfigureCodex(4318)
      assert.strictEqual(result.changed, false)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      // Above all, no `log_user_prompt = true` next to their exporter.
      assert.strictEqual(fs.readFileSync(configPath(), 'utf-8'), original)
    })

    test('reports no change when already configured', async () => {
      await autoConfigureCodex(4318)
      assert.deepStrictEqual(await autoConfigureCodex(4318), { changed: false })
    })
  })

  // os.homedir() is the sandbox; vscodeUserSettingsPaths() resolves VS Code's settings under it
  // on macOS and Linux (Windows reads APPDATA, so these skip there).
  const vscodeSettings = () => process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
    : path.join(home, '.config', 'Code', 'User', 'settings.json')
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  const read = (file: string) => fs.readFileSync(file, 'utf-8')

  // SetupMode 'maintain': every start after the yes. It keeps TraceRoost's endpoint current and
  // nothing else — above all it never re-adds a setting the user took out.
  suite("SetupMode 'maintain'", () => {
    const claudePath = () => path.join(home, '.claude', 'settings.json')
    const codexPath = () => path.join(home, '.codex', 'config.toml')

    test('Claude Code: moves TraceRoost\'s endpoint to the new port and adds nothing back', async () => {
      await autoConfigureClaudeCode(4318)
      const settings = JSON.parse(read(claudePath()))
      delete settings.env.OTEL_LOG_USER_PROMPTS
      delete settings.env.OTEL_LOG_TOOL_CONTENT
      write(claudePath(), JSON.stringify(settings, null, 2) + '\n')

      assert.deepStrictEqual(await autoConfigureClaudeCode(4318, 'maintain'), { changed: false })
      assert.deepStrictEqual(await autoConfigureClaudeCode(4320, 'maintain'), { changed: true })
      const after = JSON.parse(read(claudePath()))
      assert.strictEqual(after.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://localhost:4320')
      assert.strictEqual(after.env.OTEL_LOG_USER_PROMPTS, undefined, 'a deleted key stays deleted')
      assert.strictEqual(after.env.OTEL_LOG_TOOL_CONTENT, undefined)
      assert.deepStrictEqual(Object.keys(after.env), Object.keys(settings.env))
    })

    test('Claude Code: creates nothing and adds no missing keys', async () => {
      assert.deepStrictEqual(await autoConfigureClaudeCode(4318, 'maintain'), { changed: false })
      assert.ok(!fs.existsSync(claudePath()), 'no settings file is created')
      const original = JSON.stringify({ model: 'opus', env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }, null, 2) + '\n'
      write(claudePath(), original)
      assert.deepStrictEqual(await autoConfigureClaudeCode(4318, 'maintain'), { changed: false })
      assert.strictEqual(read(claudePath()), original)
    })

    test('Claude Code: leaves a loopback endpoint TraceRoost did not write alone', async () => {
      const original = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4317' } }, null, 2) + '\n'
      write(claudePath(), original)
      assert.deepStrictEqual(await autoConfigureClaudeCode(4318, 'maintain'), { changed: false })
      assert.strictEqual(read(claudePath()), original)
    })

    test('Codex: moves the port in place, keeping an auth header, and adds no log_user_prompt', async () => {
      const withHeaders = 'exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json", headers = { "Authorization" = "Bearer t" } } }'
      write(codexPath(), `model = "o3"\n\n[otel]\n${withHeaders}\n`)
      assert.deepStrictEqual(await autoConfigureCodex(4321, 'maintain'), { changed: true })
      assert.strictEqual(read(codexPath()), `model = "o3"\n\n[otel]\n${withHeaders.replace('4318', '4321')}\n`)
    })

    test('Codex: creates no file and no [otel] table', async () => {
      assert.deepStrictEqual(await autoConfigureCodex(4318, 'maintain'), { changed: false })
      assert.ok(!fs.existsSync(codexPath()))
      write(codexPath(), 'model = "o3"\n')
      assert.deepStrictEqual(await autoConfigureCodex(4318, 'maintain'), { changed: false })
      assert.strictEqual(read(codexPath()), 'model = "o3"\n')
    })

    test('Codex: a trace_exporter the user removed stays removed', async () => {
      await autoConfigureCodex(4318)
      const without = read(codexPath()).split('\n').filter(l => !l.startsWith('trace_exporter')).join('\n')
      write(codexPath(), without)
      await autoConfigureCodex(4319, 'maintain')
      const text = read(codexPath())
      assert.ok(!text.includes('trace_exporter'), text)
      assert.ok(text.includes('endpoint = "http://localhost:4319"'), text)
    })

    test('Copilot (settings files): moves only the endpoint', async function () {
      if (process.platform === 'win32') { this.skip() }
      const original = '{\n  // keep me\n  "github.copilot.chat.otel.otlpEndpoint": "http://localhost:4318",\n}\n'
      write(vscodeSettings(), original)
      assert.deepStrictEqual(await autoConfigureCopilotStandalone(4319, 'maintain'), [{ changed: true }])
      const text = read(vscodeSettings())
      assert.strictEqual(text, original.replace('4318', '4319'))
      assert.ok(!text.includes('otel.enabled'), 'enabled is not added back')
    })
  })

  // Remove agent setup: takes out exactly what setup wrote. Setup then remove leaves a file as it
  // was before setup — the user's own settings intact, byte for byte where setup didn't reformat.
  suite('Remove agent setup', () => {
    const claudePath = () => path.join(home, '.claude', 'settings.json')
    const codexPath = () => path.join(home, '.codex', 'config.toml')

    test('Claude Code: setup then remove round-trips, keeping the user\'s keys', async () => {
      const original = JSON.stringify({ model: 'opus', env: { FOO: 'bar' }, permissions: { allow: ['Bash(ls)'] } }, null, 2) + '\n'
      write(claudePath(), original)
      await autoConfigureClaudeCode(4318)
      assert.deepStrictEqual(await removeClaudeCodeSetup(), { file: claudePath(), changed: true })
      assert.strictEqual(read(claudePath()), original)
      assert.strictEqual(read(claudePath() + '.traceroost.bak'), original, 'the backup is not touched')
      assert.deepStrictEqual(await removeClaudeCodeSetup(), { file: claudePath(), changed: false }, 'a second remove changes nothing')
    })

    test('Claude Code: drops "env" when setup added it', async () => {
      const original = JSON.stringify({ model: 'opus' }, null, 2) + '\n'
      write(claudePath(), original)
      await autoConfigureClaudeCode(4319)
      await removeClaudeCodeSetup()
      assert.strictEqual(read(claudePath()), original)
    })

    test('Claude Code: a file setup created is left as an empty object', async () => {
      await autoConfigureClaudeCode(4318)
      await removeClaudeCodeSetup()
      assert.deepStrictEqual(JSON.parse(read(claudePath())), {})
    })

    test('Claude Code: keeps a value the user changed since setup', async () => {
      await autoConfigureClaudeCode(4318)
      const settings = JSON.parse(read(claudePath()))
      settings.env.OTEL_LOG_TOOL_DETAILS = '0'
      write(claudePath(), JSON.stringify(settings, null, 2) + '\n')
      await removeClaudeCodeSetup()
      assert.deepStrictEqual(JSON.parse(read(claudePath())), { env: { OTEL_LOG_TOOL_DETAILS: '0' } })
    })

    for (const endpoint of ['https://otel.example.com:4318', 'http://127.0.0.1:4317']) {
      test(`Claude Code: leaves a file exporting to ${endpoint} untouched`, async () => {
        const original = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOG_USER_PROMPTS: '1' } }, null, 2)
        write(claudePath(), original)
        const result = await removeClaudeCodeSetup()
        assert.strictEqual(result.changed, false)
        assert.ok(result.warning?.includes(endpoint), result.warning)
        assert.strictEqual(read(claudePath()), original)
      })
    }

    test('Claude Code: no file, nothing created', async () => {
      assert.deepStrictEqual(await removeClaudeCodeSetup(), { file: claudePath(), changed: false })
      assert.ok(!fs.existsSync(claudePath()))
    })

    test('Codex: setup appended [otel] — remove restores the file', async () => {
      const original = 'model = "o3"\n\n[profiles.x]\nmodel = "o4"\n'
      write(codexPath(), original)
      await autoConfigureCodex(4318)
      assert.deepStrictEqual(await removeCodexSetup(), { file: codexPath(), changed: true })
      assert.strictEqual(read(codexPath()), original)
    })

    test('Codex: keeps the user\'s own [otel] keys and the table', async () => {
      const original = 'model = "o3"\n\n[otel] # telemetry\nenvironment = "dev"\n\n[profiles.x]\nmodel = "o4"\n'
      write(codexPath(), original)
      await autoConfigureCodex(4318)
      assert.notStrictEqual(read(codexPath()), original)
      await removeCodexSetup()
      assert.strictEqual(read(codexPath()), original)
    })

    test('Codex: a file setup created is left empty', async () => {
      await autoConfigureCodex(4318)
      await removeCodexSetup()
      assert.strictEqual(read(codexPath()), '')
    })

    test('Codex: leaves [otel] exporting to another collector untouched', async () => {
      const original = '[otel]\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "https://otel.example.com", protocol = "json" } }\n'
      write(codexPath(), original)
      const result = await removeCodexSetup()
      assert.strictEqual(result.changed, false)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      assert.strictEqual(read(codexPath()), original)
    })

    test('Codex: an exporter line TraceRoost did not write keeps the table as it is', async () => {
      const original = '[otel]\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json", headers = { "Authorization" = "Bearer t" } } }\n' +
        'trace_exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }\n'
      write(codexPath(), original)
      const result = await removeCodexSetup()
      assert.strictEqual(result.changed, false)
      assert.strictEqual(result.customized, true, 'it sends to TraceRoost, just not in the form setup writes')
      assert.match(result.warning ?? '', /custom exporter sending to TraceRoost .*remove it by hand/)
      assert.strictEqual(read(codexPath()), original)
    })

    test('Codex: an exporter for a local collector of the user\'s is not called a custom TraceRoost exporter', async () => {
      const original = '[otel]\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:4317", protocol = "binary" } }\n' +
        'trace_exporter = { otlp-http = { endpoint = "http://localhost:4318", protocol = "json" } }\n'
      write(codexPath(), original)
      const result = await removeCodexSetup()
      assert.strictEqual(result.changed, false)
      assert.strictEqual(result.customized, undefined)
      assert.strictEqual(read(codexPath()), original)
    })

    test('Copilot (settings files): setup then remove keeps comments and the user\'s settings', async function () {
      if (process.platform === 'win32') { this.skip() }
      const original = '{\n  // keep me\n  "editor.fontSize": 14\n}\n'
      write(vscodeSettings(), original)
      await autoConfigureCopilotStandalone(4318)
      assert.deepStrictEqual(await removeCopilotStandaloneSetup(), [{ file: vscodeSettings(), changed: true }])
      assert.strictEqual(read(vscodeSettings()), original)
    })

    test('Copilot (settings files): takes out otel.enabled that relied on Copilot\'s default endpoint (4318)', async function () {
      if (process.platform === 'win32') { this.skip() }
      const original = '{\n  "editor.fontSize": 14\n}\n'
      write(vscodeSettings(), '{\n  "editor.fontSize": 14,\n  "github.copilot.chat.otel.enabled": true\n}\n')
      assert.deepStrictEqual(await removeCopilotStandaloneSetup({ port: 4319 }), [{ file: vscodeSettings(), changed: false }],
        'on another port the default endpoint is not TraceRoost\'s')
      assert.deepStrictEqual(await removeCopilotStandaloneSetup({ port: 4318 }), [{ file: vscodeSettings(), changed: true }])
      assert.strictEqual(read(vscodeSettings()), original)
    })

    test('Copilot (settings files): leaves another collector\'s endpoint untouched', async function () {
      if (process.platform === 'win32') { this.skip() }
      const original = '{ "github.copilot.chat.otel.enabled": true, "github.copilot.chat.otel.otlpEndpoint": "https://otel.example.com" }\n'
      write(vscodeSettings(), original)
      const [result] = await removeCopilotStandaloneSetup()
      assert.strictEqual(result.changed, false)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      assert.strictEqual(read(vscodeSettings()), original)
    })
  })
})
