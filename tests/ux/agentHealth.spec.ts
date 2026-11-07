import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Adapter health in the dashboard (media/src/tabs/AgentHealth.tsx). The Traces tab's banner is
 * only for data actually lost recently (`banner` from src/adapters/health.ts), one per agent,
 * worded in sessions rather than record names; records TraceRoost merely skips show only in
 * Settings → Agents.
 */

const DAY = 86_400_000
const version = (v: string, o: Partial<Record<string, unknown>>) => ({
  version: v, known: 40, ignored: 10, unknown: 0, unknownNames: {}, unreadFiles: 0, damaged: 0,
  impact: 'none', lastImpactMs: null, banner: false, ...o,
})
const row = (key: string, label: string, status: string, versions: unknown[]) => ({
  key, label, support: 'verified', lastVerifiedVersion: null, versionSeen: (versions[0] as { version: string } | undefined)?.version ?? null,
  lastFilesMs: Date.now() - 60_000, lastOtlpMs: null, status, versions,
})
const report = { title: 'Codex 0.163.0: unrecognized data', body: '**Agent:** Codex', url: 'https://github.com/traceroost/core/issues/new?title=x' }

const rows = [
  // Skipped records only: Settings, no banner.
  row('claude', 'Claude Code', 'unrecognized', [
    version('2.1.318', { unknown: 152, unknownNames: { 'session-owner': 135, 'tools-used': 17 }, impact: 'skipped', lastImpactMs: Date.now() - DAY }),
  ]),
  // Two recent versions that lost sessions, and an old one that did too.
  row('codex', 'Codex', 'missing-data', [
    version('0.163.0', { unknown: 21, unknownNames: { world_state: 2, token_usage_record: 19 }, unreadFiles: 2, impact: 'loss', lastImpactMs: Date.now() - DAY, banner: true, report }),
    version('0.162.0', { unknown: 9, unknownNames: { world_state: 9 }, unreadFiles: 1, impact: 'loss', lastImpactMs: Date.now() - 2 * DAY, banner: true }),
    version('0.154.0-alpha.6.1', { unknown: 57, unknownNames: { world_state: 57 }, unreadFiles: 2, impact: 'loss', lastImpactMs: Date.now() - 40 * DAY }),
  ]),
]

async function load(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((s) => window.postMessage({ type: 'update', sessionSummary: { sessions: s } }, '*'), sessions.slice(0, 4))
  await page.evaluate((r) => window.postMessage({ type: 'adapterHealth', rows: r }, '*'), rows)
}

test('one banner per agent that recently lost data, in sessions not record names; dismiss covers its versions', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await load(page)

  const banners = page.getByRole('status').filter({ hasText: 'couldn\'t be fully read' })
  await expect(banners).toHaveCount(1)
  await expect(banners).toContainText('Codex: 3 sessions couldn\'t be fully read')
  await expect(banners).toContainText('versions 0.163.0 and 0.162.0')
  await expect(banners).not.toContainText('world_state')
  await expect(page.getByText('Claude Code', { exact: false }).filter({ hasText: 'unrecognized' })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('banner.png') })

  await banners.getByRole('button', { name: 'Report this' }).click()
  await expect(page.getByLabel('Issue body')).toContainText('**Agent:** Codex')

  await banners.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banners).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Settings → Agents shows every version with unrecognized records, with what it cost', async ({ page }) => {
  await load(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const agents = page.locator('#settings-agents')
  await agents.scrollIntoViewIfNeeded()
  await expect(agents).toContainText('Missing data')
  await expect(agents).toContainText('Unrecognized data')
  await expect(agents).toContainText('2.1.318: sessions read, skipped 152 unrecognized records: session-owner, tools-used')
  await expect(agents).toContainText('0.154.0-alpha.6.1: 2 sessions couldn\'t be fully read — 57 unrecognized records: world_state (last 40d ago)')
  await agents.screenshot({ path: test.info().outputPath('settings-agents.png') })
})
