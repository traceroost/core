import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The Traces table's "Limit" column shows one window (5h, or weekly when that's all there
 * is); expanding the trace shows every window.
 */
const rows = sessions.slice(0, 2)

async function loadWithPlanUsage(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), rows)
  await page.evaluate(
    ([a, b]) =>
      window.postMessage(
        {
          type: 'planUsage',
          snapshot: {
            generatedAt: Date.now(),
            meters: [],
            sessions: {
              [a]: { fiveHourPct: 12.4, weeklyPct: 3, approximate: false },
              [b]: { weeklyPct: 7, approximate: true },
            },
            series: { weekly: [], fiveHour: [] },
            hits: [],
            weeklyRollups: [],
            historyStartsAt: {},
          },
        },
        '*',
      ),
    [rows[0].sessionId, rows[1].sessionId],
  )
  await page.locator('#sessions-content tbody tr').first().waitFor()
}

/**
 * Plan-limit readings are approximate, so Settings › Show plan limits starts off: with plan data
 * recorded, nothing about limits shows until it's turned on, and then Plan limits sits last on
 * Analytics › Cost (media/src/planUsage.ts).
 */
test('plan limits stay hidden until Settings turns them on', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await loadWithPlanUsage(page)
  const table = page.locator('#sessions-content')
  await expect(table.locator('th', { hasText: /^Limit$/ })).toHaveCount(0)
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.locator('[data-view-panel=cost]')).toBeVisible()
  await expect(page.locator('#analytics-plan-limits')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const toggle = page.locator('[data-setting=show-plan-limits] input[type=checkbox]')
  await expect(toggle).not.toBeChecked()
  await page.locator('[data-setting=show-plan-limits] label.toggle-switch').click()
  await expect(toggle).toBeChecked()
  await page.keyboard.press('Escape')

  const section = page.locator('#analytics-plan-limits')
  await expect(section).toBeVisible()
  await expect(section).toContainText('Approximate')
  // Last in the view, after the cost and token charts.
  const last = await page.locator('[data-view-panel=cost] section.view-section').evaluateAll((els) => els.at(-1)?.id)
  expect(last).toBe('analytics-plan-limits')

  // The choice survives a reload.
  await loadWithPlanUsage(page)
  await expect(table.locator('th', { hasText: /^Limit$/ })).toBeVisible()
  expect(errors, 'browser errors').toEqual([])
})

test('Limit column shows one window; the expanded trace shows both', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('traceroost-show-plan-limits', 'true'))
  await loadWithPlanUsage(page)
  const table = page.locator('#sessions-content')
  await expect(table.locator('th', { hasText: /^Limit$/ })).toBeVisible()
  await expect(table.getByText('5h 12%', { exact: true })).toBeVisible()
  await expect(table.getByText('≈ wk 7%', { exact: true })).toBeVisible()
  await expect(table.getByText(/wk 3%/)).toHaveCount(0)

  await table.getByText('5h 12%', { exact: true }).click()
  const detail = page.locator('[data-testid=plan-limit-detail]')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('5-hour 12%')
  await expect(detail).toContainText('Weekly 3%')
  expect(errors, 'browser errors').toEqual([])
})
