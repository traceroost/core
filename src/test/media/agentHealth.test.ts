import * as assert from 'assert'
import './domShim'
import { bannerAgents, dismissAgentBanner, dismissedAgentBanners, lossSummary, type AgentHealthRow, type VersionHealth } from '../../../media/src/agentHealth'

// The agent banner on the Traces tab (media/src/tabs/AgentHealth.tsx): one per agent with versions
// that raise it, under the agent filter, until dismissed — per version, so a newer one raises it
// again.

const version = (v: string, banner: boolean, unreadFiles = banner ? 1 : 0): VersionHealth => ({
  version: v, known: 10, ignored: 0, unknown: banner ? 6 : 0, unknownNames: banner ? { x: 6 } : {},
  unreadFiles, damaged: 0, impact: banner ? 'loss' : 'none', lastImpactMs: banner ? 1 : null, banner,
})
const row = (key: AgentHealthRow['key'], versions: VersionHealth[]): AgentHealthRow => ({
  key, label: key, support: 'verified', lastVerifiedVersion: null, versionSeen: versions[0]?.version ?? null,
  lastFilesMs: 1, lastOtlpMs: null, status: versions.some(v => v.banner) ? 'missing-data' : 'ok', versions,
})

suite('agent health banner', () => {
  const g = globalThis as { localStorage?: unknown }
  const hadStorage = g.localStorage
  teardown(() => { g.localStorage = hadStorage })

  const rows = [
    row('claude', [version('2.1.0', false)]),
    row('codex', [version('0.162.0', true), version('0.154.0', true)]),
    row('copilot_vscode', [version('unknown', true)]),
  ]

  test('one banner per agent, with its flagged versions, for the agents the filter shows', () => {
    const ids = (filter: string, dismissed: string[] = []) => bannerAgents(rows, filter, dismissed).map(b => `${b.row.key}@${b.versions.map(v => v.version).join('+')}`)
    assert.deepStrictEqual(ids('all'), ['codex@0.162.0+0.154.0', 'copilot_vscode@unknown'])
    assert.deepStrictEqual(ids('codex'), ['codex@0.162.0+0.154.0'])
    assert.deepStrictEqual(ids('copilot'), ['copilot_vscode@unknown'])
    assert.deepStrictEqual(ids('claude_code'), [])
    assert.deepStrictEqual(ids('all', ['codex@0.162.0']), ['codex@0.154.0', 'copilot_vscode@unknown'])
    assert.deepStrictEqual(ids('all', ['codex@0.162.0', 'codex@0.154.0']), ['copilot_vscode@unknown'])
    assert.deepStrictEqual(bannerAgents(null, 'all', []), [])
  })

  test('the banner says what was lost, not which records', () => {
    assert.strictEqual(lossSummary([version('1', true, 3), version('2', true, 1)]), "4 sessions couldn't be fully read")
    assert.strictEqual(lossSummary([version('1', true, 1)]), "1 session couldn't be fully read")
    assert.strictEqual(lossSummary([version('1', true, 0)]), 'some sessions are missing cost or prompt data')
  })

  test('dismissing covers the versions the banner spoke for, and is remembered', () => {
    const store = new Map<string, string>()
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } }
    dismissAgentBanner('codex', ['0.162.0', '0.154.0'])
    assert.ok(dismissedAgentBanners.value.includes('codex@0.162.0'))
    assert.ok(dismissedAgentBanners.value.includes('codex@0.154.0'))
    assert.ok(!dismissedAgentBanners.value.includes('codex@0.163.0'))
    assert.strictEqual(store.get('traceRoost.agentBannerDismissed'), JSON.stringify(dismissedAgentBanners.value))
  })
})
