import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The filter bar's Agent pills list "All" plus only the agents some loaded trace has
 * (state.ts availableAgents), in the fixed pill order. With one agent (or none) holding data the
 * row is hidden — unless an agent is selected, which keeps the row (and that pill) so the active
 * filter stays visible and clearable.
 */
const ORDER = ['All', 'Copilot', 'Claude', 'Codex', 'OpenCode', 'Cursor']

async function load(page: Page, list: unknown[]) {
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), list)
}

test('agent pills only for agents with data; row hidden for a single agent', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  const row = page.locator('.time-range-bar .tr-agent-filter')
  const pills = row.locator('button.tr-pill')

  // Two agents (Codex listed before Claude in the data): pill order is the fixed order, not data order.
  const two = sessions.slice(0, 6).map((s, i) => ({ ...s, source: i % 2 ? 'claude_code' : 'codex' }))
  await load(page, two)
  const rows = page.locator('#sessions-content tbody tr')
  await expect(rows).toHaveCount(6)
  await expect(pills).toHaveText(['All', 'Claude', 'Codex'])

  // Picking an agent narrows the table but keeps the other agent's pill (read from all traces).
  await row.getByRole('button', { name: 'Codex', exact: true }).click()
  await expect(rows).toHaveCount(3)
  await expect(pills).toHaveText(['All', 'Claude', 'Codex'])

  // Codex traces go away while Codex is selected: its pill stays so the filter can be cleared.
  await load(page, two.filter((s) => s.source === 'claude_code'))
  await expect(pills).toHaveText(['All', 'Claude', 'Codex'])
  await expect(row.getByRole('button', { name: 'Codex', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // Back to All with a single agent left: nothing to choose between, so the row hides.
  await row.getByRole('button', { name: 'All', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(rows).toHaveCount(3)

  // All five agents: every pill, in order.
  await load(page, sessions.slice(0, 10).map((s, i) => ({ ...s, source: ['copilot', 'claude_code', 'codex', 'opencode', 'cursor'][i % 5] })))
  await expect(pills).toHaveText(ORDER)

  // No traces at all: hidden.
  await load(page, [])
  await expect(row).toHaveCount(0)
  expect(errors, 'browser errors').toEqual([])
})
