import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The Traces table's "Plan limit" column shows one window (5h, or weekly when that's all there
 * is); expanding the trace shows every window.
 */
test('Plan limit column shows one window; the expanded trace shows both', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const rows = sessions.slice(0, 2)
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
  const table = page.locator('#sessions-content')
  await expect(table.locator('th', { hasText: /^Plan limit$/ })).toBeVisible()
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
