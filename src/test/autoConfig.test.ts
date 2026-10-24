import * as assert from 'assert'
import * as vscode from 'vscode'
import { autoConfigureCopilot, removeCopilotSetup } from '../autoConfig'

type Settings = Record<string, unknown>

/** Stands in for vscode.workspace.getConfiguration() with a settings registry: `registered` lists
 *  the keys a contributing extension has declared (with their defaults). */
function withConfig(registered: Settings, values: Settings, fn: (writes: Array<[string, unknown]>) => Promise<void>): Promise<void> {
  const writes: Array<[string, unknown]> = []
  const ws = vscode.workspace as unknown as { getConfiguration: () => unknown }
  const original = ws.getConfiguration
  ws.getConfiguration = () => ({
    get: (key: string) => values[key] ?? registered[key],
    inspect: (key: string) => ({ key, defaultValue: registered[key], globalValue: values[key] }),
    update: async (key: string, value: unknown) => {
      if (!(key in registered)) throw new Error(`Unable to write to User Settings because ${key} is not a registered configuration.`)
      writes.push([key, value]); values[key] = value
    },
  })
  return fn(writes).finally(() => { ws.getConfiguration = original })
}

const COPILOT_DEFAULTS = {
  'github.copilot.chat.otel.enabled': false,
  'github.copilot.chat.otel.exporterType': 'console',
  'github.copilot.chat.otel.otlpEndpoint': '',
}

/** Copilot Chat's real defaults (its package.json): exporterType and endpoint already point at
 *  port 4318 before anything is set. */
const COPILOT_BUILTIN_DEFAULTS = {
  'github.copilot.chat.otel.enabled': false,
  'github.copilot.chat.otel.exporterType': 'otlp-http',
  'github.copilot.chat.otel.otlpEndpoint': 'http://localhost:4318',
}

suite('autoConfigureCopilot', () => {
  test('without Copilot Chat installed (settings unregistered) it is a silent no-op, not an error', () =>
    withConfig({}, {}, async writes => {
      assert.deepStrictEqual(await autoConfigureCopilot(4318), { changed: false })
      assert.deepStrictEqual(writes, [])
    }))

  test('with Copilot Chat installed it points OTEL at the collector', () =>
    withConfig(COPILOT_DEFAULTS, {}, async writes => {
      assert.deepStrictEqual(await autoConfigureCopilot(4318), { changed: true })
      assert.deepStrictEqual(writes, [
        ['github.copilot.chat.otel.enabled', true],
        ['github.copilot.chat.otel.exporterType', 'otlp-http'],
        ['github.copilot.chat.otel.otlpEndpoint', 'http://localhost:4318'],
      ])
      assert.deepStrictEqual(await autoConfigureCopilot(4318), { changed: false }, 'second run changes nothing')
    }))

  test('leaves an endpoint aimed at the user\'s own collector alone, with a warning', () =>
    withConfig(COPILOT_DEFAULTS, {
      'github.copilot.chat.otel.enabled': true,
      'github.copilot.chat.otel.exporterType': 'otlp-http',
      'github.copilot.chat.otel.otlpEndpoint': 'https://otel.example.com',
    }, async writes => {
      const result = await autoConfigureCopilot(4318)
      assert.strictEqual(result.changed, false)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      assert.deepStrictEqual(writes, [])
    }))

  test('with telemetry off and the user\'s own collector set, it does not switch telemetry on', () =>
    withConfig(COPILOT_DEFAULTS, {
      'github.copilot.chat.otel.enabled': false,
      'github.copilot.chat.otel.otlpEndpoint': 'https://otel.example.com',
    }, async writes => {
      const result = await autoConfigureCopilot(4318)
      assert.strictEqual(result.changed, false)
      assert.deepStrictEqual(writes, [], 'turning it on would send Copilot telemetry to their collector')
    }))

  test("'maintain' moves only TraceRoost's endpoint and never switches telemetry back on", () =>
    withConfig(COPILOT_DEFAULTS, {
      'github.copilot.chat.otel.enabled': false,
      'github.copilot.chat.otel.otlpEndpoint': 'http://localhost:4318',
    }, async writes => {
      assert.deepStrictEqual(await autoConfigureCopilot(4318, 'maintain'), { changed: false })
      assert.deepStrictEqual(await autoConfigureCopilot(4320, 'maintain'), { changed: true })
      assert.deepStrictEqual(writes, [['github.copilot.chat.otel.otlpEndpoint', 'http://localhost:4320']])
    }))

  test("'maintain' adds no endpoint that isn't there", () =>
    withConfig(COPILOT_DEFAULTS, {}, async writes => {
      assert.deepStrictEqual(await autoConfigureCopilot(4318, 'maintain'), { changed: false })
      assert.deepStrictEqual(writes, [])
    }))

  test('Remove agent setup takes out the three user settings setup wrote', () =>
    withConfig(COPILOT_DEFAULTS, {}, async writes => {
      await autoConfigureCopilot(4318)
      writes.length = 0
      assert.deepStrictEqual(await removeCopilotSetup(), { changed: true })
      assert.deepStrictEqual(writes, [
        ['github.copilot.chat.otel.enabled', undefined],
        ['github.copilot.chat.otel.exporterType', undefined],
        ['github.copilot.chat.otel.otlpEndpoint', undefined],
      ])
      assert.deepStrictEqual(await removeCopilotSetup(), { changed: false }, 'a second remove changes nothing')
    }))

  test('on port 4318, setup writes all three user settings even though Copilot\'s defaults match two', () =>
    withConfig(COPILOT_BUILTIN_DEFAULTS, {}, async writes => {
      assert.deepStrictEqual(await autoConfigureCopilot(4318), { changed: true })
      assert.deepStrictEqual(writes, [
        ['github.copilot.chat.otel.enabled', true],
        ['github.copilot.chat.otel.exporterType', 'otlp-http'],
        ['github.copilot.chat.otel.otlpEndpoint', 'http://localhost:4318'],
      ])
    }))

  test('Remove agent setup takes out what an earlier setup on 4318 left (only otel.enabled)', () =>
    withConfig(COPILOT_BUILTIN_DEFAULTS, { 'github.copilot.chat.otel.enabled': true }, async writes => {
      assert.deepStrictEqual(await removeCopilotSetup({ port: 4318, dryRun: true }), { changed: true })
      assert.deepStrictEqual(writes, [], 'a dry run writes nothing')
      assert.deepStrictEqual(await removeCopilotSetup({ port: 4318 }), { changed: true })
      assert.deepStrictEqual(writes, [['github.copilot.chat.otel.enabled', undefined]])
    }))

  test('Remove agent setup also drops a user-level exporterType when the default endpoint is TraceRoost\'s', () =>
    withConfig(COPILOT_BUILTIN_DEFAULTS, {
      'github.copilot.chat.otel.enabled': true,
      'github.copilot.chat.otel.exporterType': 'otlp-http',
    }, async writes => {
      assert.deepStrictEqual(await removeCopilotSetup({ port: 4318 }), { changed: true })
      assert.deepStrictEqual(writes, [
        ['github.copilot.chat.otel.enabled', undefined],
        ['github.copilot.chat.otel.exporterType', undefined],
      ])
    }))

  test('Remove agent setup leaves telemetry on the default endpoint alone when TraceRoost is on another port', () =>
    withConfig(COPILOT_BUILTIN_DEFAULTS, { 'github.copilot.chat.otel.enabled': true }, async writes => {
      assert.deepStrictEqual(await removeCopilotSetup({ port: 4320 }), { changed: false })
      assert.deepStrictEqual(await removeCopilotSetup(), { changed: false }, 'without the port nothing marks it as TraceRoost\'s')
      assert.deepStrictEqual(writes, [])
    }))

  test('Remove agent setup leaves the user\'s own collector alone', () =>
    withConfig(COPILOT_DEFAULTS, {
      'github.copilot.chat.otel.enabled': true,
      'github.copilot.chat.otel.otlpEndpoint': 'https://otel.example.com',
    }, async writes => {
      const result = await removeCopilotSetup()
      assert.strictEqual(result.changed, false)
      assert.match(result.warning ?? '', /otel\.example\.com/)
      assert.deepStrictEqual(writes, [])
    }))
})
