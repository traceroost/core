import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { autoConfigureClaudeCode, autoConfigureCodex, autoConfigureCopilotStandalone } from '../autoConfigNode'

suite('autoConfigNode', () => {
  let home: string
  let savedHome: string | undefined
  let savedCodexHome: string | undefined

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-autoconfig-test-'))
    savedHome = process.env.HOME
    savedCodexHome = process.env.CODEX_HOME
    process.env.HOME = home
    delete process.env.CODEX_HOME
  })

  teardown(() => {
    if (savedHome === undefined) { delete process.env.HOME } else { process.env.HOME = savedHome }
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

    test('does not overwrite a user endpoint pointing at another collector', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
      fs.writeFileSync(settingsPath(), JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com:4318' },
      }))
      const result = await autoConfigureClaudeCode(4318)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
      assert.strictEqual(written.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://otel.example.com:4318')
    })

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

    test('reports no change when already configured', async () => {
      await autoConfigureCodex(4318)
      assert.deepStrictEqual(await autoConfigureCodex(4318), { changed: false })
    })
  })
})
