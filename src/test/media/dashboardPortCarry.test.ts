import * as assert from 'assert'
import { movedDashboardUrl, DASHBOARD_CARRY_KEYS } from '../../../media/src/dashboardPortCarry'
import { carryImportScript } from '../../../standalone/dashboardPort'

suite('dashboardPortCarry', () => {
  test('builds the new address on the same host, with the stored preferences in the fragment', () => {
    const stored: Record<string, string> = { 'traceroost-theme': 'light', unrelated: 'x' }
    const url = new URL(movedDashboardUrl(3100, { protocol: 'http:', hostname: '127.0.0.1' }, { getItem: k => stored[k] ?? null }))
    assert.strictEqual(url.origin, 'http://127.0.0.1:3100')
    assert.strictEqual(url.pathname, '/')
    const data = JSON.parse(decodeURIComponent(url.hash.slice('#carry='.length)))
    assert.deepStrictEqual(data, { moved: 3100, items: { 'traceroost-theme': 'light' } })
  })

  test('works with no storage at all', () => {
    const url = movedDashboardUrl(3100, { protocol: 'http:', hostname: 'localhost' }, null)
    assert.ok(url.startsWith('http://localhost:3100/#carry='))
  })

  test("round trip: what the page sends is what the new page's import script stores", () => {
    const before: Record<string, string> = {
      'traceroost-theme': 'dark',
      'traceroost-sessions-page-size': '100',
      'traceRoost.agentProfiles': JSON.stringify({ claude: { name: 'Ünïcode & "quotes"' } }),
    }
    const url = new URL(movedDashboardUrl(4400, { protocol: 'http:', hostname: 'localhost' }, { getItem: k => before[k] ?? null }))
    const after: Record<string, string> = {}
    const win: Record<string, unknown> = {}
    new Function('location', 'history', 'localStorage', 'window', carryImportScript())(
      { hash: url.hash, pathname: '/', search: '' },
      { replaceState: () => {} },
      { setItem: (k: string, v: string) => { after[k] = v } },
      win,
    )
    assert.deepStrictEqual(after, before)
    assert.deepStrictEqual(Object.keys(after).sort(), [...DASHBOARD_CARRY_KEYS].sort())
    assert.strictEqual(win.__DASHBOARD_MOVED_TO__, 4400)
  })
})
