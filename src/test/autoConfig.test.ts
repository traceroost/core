import * as assert from 'assert'
import * as vscode from 'vscode'
import { autoConfigureCopilot } from '../autoConfig'

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
})
