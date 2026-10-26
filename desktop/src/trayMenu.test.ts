import * as assert from 'assert'
import { type CollectorState } from './collector'
import { type CollectorIdentity } from './handshake'
import { type ShellMode } from './mode'
import { buildMenuModel, collectionProblem, describeCollectorState, shortErrorText, type MenuItemId, type MenuItemModel } from './trayMenu'

function identity(over: Partial<CollectorIdentity> = {}): CollectorIdentity {
  return {
    pid: 2000, hostname: 'box-a', startedAt: '2026-10-13T12:00:00.000Z', service: false,
    uiPort: 3000, otlpPort: 4318, mcpPort: 4316, version: '0.19.1', ...over,
  }
}

function model(shell: ShellMode, collector: CollectorState, launchAtLogin = false) {
  return buildMenuModel({ shell, collector, launchAtLogin, version: '0.19.1' })
}

function item(m: ReturnType<typeof model>, id: MenuItemId): MenuItemModel | undefined {
  return m.items.find((i): i is MenuItemModel => !('separator' in i) && i.id === id)
}

const RUNNING: CollectorState = { status: 'running', pid: 1, uiPort: 3000, otlpPort: 4318, mcpPort: 4316 }

suite('trayMenu — status wording', () => {
  test('a stopped collector says collection is stopped, not that an exporter is paused', () => {
    const { label, accessibilityLabel } = describeCollectorState({ status: 'stopped' })
    assert.strictEqual(label, 'Collection stopped')
    assert.match(accessibilityLabel, /Nothing is being recorded/)
  })

  test('a failed collector says it is not collecting, and does not look like a transient blip', () => {
    const { label, accessibilityLabel } = describeCollectorState({ status: 'failed', lastError: 'port in use' })
    assert.match(label, /not collecting/)
    assert.match(accessibilityLabel, /will not retry/)
    assert.match(accessibilityLabel, /port in use/)
  })

  test('the running label names the port actually bound, not the one configured', () => {
    assert.match(describeCollectorState({ ...RUNNING, uiPort: 3007 }).label, /port 3007/)
  })

  test('a retrying collector still says collection is stopped meanwhile', () => {
    const { label } = describeCollectorState({ status: 'restarting', attempt: 2, nextAttemptInMs: 2000, lastError: 'x' })
    assert.match(label, /stopped/)
    assert.match(label, /retrying in 2s/)
  })
})

suite('trayMenu — owned mode', () => {
  test('Start/Stop/Restart are present, and enabled according to the collector', () => {
    const m = model({ mode: 'own' }, RUNNING)
    assert.strictEqual(item(m, 'stop')?.enabled, true)
    assert.strictEqual(item(m, 'restart')?.enabled, true)
    assert.strictEqual(item(m, 'start')?.enabled, false)
    assert.strictEqual(item(m, 'open-dashboard')?.enabled, true)
  })

  test('nothing is startable twice while a start is already in flight', () => {
    const m = model({ mode: 'own' }, { status: 'starting' })
    assert.strictEqual(item(m, 'start')?.enabled, false)
    assert.strictEqual(item(m, 'stop')?.enabled, false)
  })

  test('a failed collector can be restarted, which is the way out of the give-up state', () => {
    const m = model({ mode: 'own' }, { status: 'failed', lastError: 'x' })
    assert.strictEqual(item(m, 'start')?.enabled, true)
    assert.strictEqual(item(m, 'restart')?.enabled, true)
  })

  test('Open Dashboard is unavailable while nothing is serving it, and says why', () => {
    const m = model({ mode: 'own' }, { status: 'stopped' })
    assert.strictEqual(item(m, 'open-dashboard')?.enabled, false)
    assert.match(item(m, 'open-dashboard')?.accessibilityLabel ?? '', /Unavailable until/)
  })

  test('Quit in owned mode does not promise to leave anything running', () => {
    assert.strictEqual(item(model({ mode: 'own' }, RUNNING), 'quit')?.label, 'Quit TraceRoost')
  })
})

suite('trayMenu — attached mode', () => {
  const attached: ShellMode = { mode: 'attach', identity: identity({ service: true }) }

  test('collector controls are absent, not greyed out — stopping it is not this app\'s to do', () => {
    const m = model(attached, { status: 'stopped' })
    assert.strictEqual(item(m, 'start'), undefined)
    assert.strictEqual(item(m, 'stop'), undefined)
    assert.strictEqual(item(m, 'restart'), undefined)
  })

  test('the dashboard is reachable even though the shell owns no collector', () => {
    assert.strictEqual(item(model(attached, { status: 'stopped' }), 'open-dashboard')?.enabled, true)
  })

  test('the status says it is collecting, and that the collector is not ours', () => {
    const m = model(attached, { status: 'stopped' })
    assert.match(item(m, 'status')?.label ?? '', /Collecting/)
    assert.match(item(m, 'status')?.label ?? '', /background service/)
    assert.match(item(m, 'status')?.accessibilityLabel ?? '', /this app does not manage/)
  })

  test('Quit warns that the other collector keeps running', () => {
    assert.match(item(model(attached, { status: 'stopped' }), 'quit')?.label ?? '', /leaves the collector running/)
  })
})

suite('trayMenu — other modes', () => {
  test('a collector pending confirmation offers that, and no collector controls', () => {
    const m = model({ mode: 'confirm-attach', identity: identity(), question: 'Use it?' }, { status: 'stopped' })
    assert.strictEqual(item(m, 'attach')?.enabled, true)
    assert.strictEqual(item(m, 'start'), undefined)
    assert.strictEqual(item(m, 'open-dashboard')?.enabled, false)
  })

  test('a blocked shell surfaces the reason through the accessible label, not just a terse line', () => {
    const m = model({ mode: 'blocked', detail: 'held by pid 9 on box-b' }, { status: 'stopped' })
    assert.match(item(m, 'status')?.label ?? '', /needs attention/)
    assert.match(item(m, 'status')?.accessibilityLabel ?? '', /box-b/)
  })
})

suite('trayMenu — invariants across every mode', () => {
  const shells: ShellMode[] = [
    { mode: 'own' },
    { mode: 'attach', identity: identity() },
    { mode: 'confirm-attach', identity: identity(), question: 'q' },
    { mode: 'wait', detail: 'starting', retryInMs: 1500 },
    { mode: 'blocked', detail: 'nope' },
  ]

  test('every mode offers Open Logs, Launch at Login, About and Quit', () => {
    for (const shell of shells) {
      const m = model(shell, { status: 'stopped' })
      for (const id of ['open-logs', 'launch-at-login', 'about', 'quit'] as const) {
        assert.ok(item(m, id), `${shell.mode} is missing ${id}`)
      }
    }
  })

  test('the status line is never clickable', () => {
    for (const shell of shells) {
      const status = item(model(shell, RUNNING), 'status')
      assert.strictEqual(status?.enabled, false, shell.mode)
      assert.strictEqual(status?.isStatus, true, shell.mode)
    }
  })

  test('Launch at Login reflects the real setting and is off by default', () => {
    assert.strictEqual(item(model({ mode: 'own' }, RUNNING, false), 'launch-at-login')?.checked, false)
    assert.strictEqual(item(model({ mode: 'own' }, RUNNING, true), 'launch-at-login')?.checked, true)
  })

  test('the tooltip carries the same status as the menu, so the hover never contradicts it', () => {
    for (const shell of shells) {
      const m = model(shell, RUNNING)
      assert.ok(m.tooltip.includes(item(m, 'status')?.label ?? '\u0000'), shell.mode)
    }
  })
})

suite('trayMenu — AppImage launcher entry', () => {
  test('only an AppImage gets the item, and it reflects whether the entry exists', () => {
    assert.strictEqual(item(model({ mode: 'own' }, RUNNING), 'applications-menu'), undefined)
    const on = buildMenuModel({ shell: { mode: 'own' }, collector: RUNNING, launchAtLogin: false, version: '0.19.1', inApplicationsMenu: true })
    assert.strictEqual(item(on, 'applications-menu')?.checked, true)
    const off = buildMenuModel({ shell: { mode: 'own' }, collector: RUNNING, launchAtLogin: false, version: '0.19.1', inApplicationsMenu: false })
    assert.strictEqual(item(off, 'applications-menu')?.checked, false)
  })
})

suite('trayMenu — the failure reason is visible', () => {
  const longError = 'the collector exited with code 1 before it was ready because port 3000 and every port after it were busy\n[TraceRoost] UI server error: EADDRINUSE'

  test('a failed collector shows a short error line and Show Error…', () => {
    const m = model({ mode: 'own' }, { status: 'failed', lastError: longError })
    const line = item(m, 'error-summary')
    assert.ok(line, 'error line present')
    assert.strictEqual(line.enabled, false)
    assert.ok(line.label.length <= 60, line.label)
    assert.match(line.label, /^the collector exited with code 1/)
    assert.strictEqual(item(m, 'show-error')?.enabled, true)
    assert.deepStrictEqual(collectionProblem({ mode: 'own' }, { status: 'failed', lastError: longError }), { title: 'Collection failed', detail: longError })
  })

  test('a blocked data dir shows why, too', () => {
    const m = model({ mode: 'blocked', detail: 'Another collector on this machine holds the data directory.' }, { status: 'stopped' })
    assert.strictEqual(item(m, 'error-summary')?.label, 'Another collector on this machine holds the data directory.')
    assert.ok(item(m, 'show-error'))
  })

  test('nothing extra while things are fine', () => {
    for (const m of [model({ mode: 'own' }, RUNNING), model({ mode: 'own' }, { status: 'stopped' }), model({ mode: 'attach', identity: identity() }, { status: 'stopped' })]) {
      assert.strictEqual(item(m, 'error-summary'), undefined)
      assert.strictEqual(item(m, 'show-error'), undefined)
    }
  })

  test('shortErrorText keeps the first non-empty line and truncates it', () => {
    assert.strictEqual(shortErrorText('\n  boom  \nmore'), 'boom')
    assert.strictEqual(shortErrorText(''), 'Unknown error')
    assert.strictEqual(shortErrorText('x'.repeat(100), 20), `${'x'.repeat(19)}…`)
  })
})
