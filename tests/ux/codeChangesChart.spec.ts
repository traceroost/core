import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Analytics → Code changes over time: agent-authored lines added/removed and files changed per
 * day. Traces with no recorded line counts are left out and counted in a note; with none at all
 * the chart shows its empty state. Runs on every project (desktop/mobile, light/dark).
 */
const DAY = 86_400_000

async function load(page: Page, list: unknown[]) {
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), list)
}

// 12 traces over six days with line data, plus two with none: an agent that records no edit
// contents (files only, lines "?") and one stored before change-size tracking.
const now = Date.now()
const withChanges = sessions.slice(0, 14).map((s, i) => ({
  ...s,
  startTime: new Date(now - Math.floor(i / 2) * DAY - 3_600_000).toISOString(),
  ...(i < 12 ? { filesChangedCount: 1 + (i % 3), linesAdded: 20 + i * 15, linesRemoved: (i % 4) * 9 } : {}),
  ...(i === 12 ? { filesChangedCount: 4 } : {}),
}))

test('code changes chart renders, notes excluded traces, and has an empty state', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await load(page, withChanges)
  await page.locator('#sessions-content tbody tr').first().waitFor()
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()

  await expect(page.locator('#analytics-code-changes')).toContainText('CODE CHANGES OVER TIME')
  const chart = page.locator('[data-testid=code-changes-chart]')
  await expect(chart).toBeVisible()
  const total = { added: 0, removed: 0, files: 0 }
  for (const s of withChanges.slice(0, 12)) {
    total.added += s.linesAdded ?? 0
    total.removed += s.linesRemoved ?? 0
    total.files += s.filesChangedCount ?? 0
  }
  await expect(chart.locator('svg')).toHaveAttribute(
    'aria-label',
    new RegExp(`${total.added.toLocaleString('en-US')} added, ${total.removed} removed, ${total.files} files changed, across 12 traces`),
  )
  await expect(page.locator('[data-testid=code-changes-note]')).toContainText('2 traces without change data not counted')

  // Tooltip on hover: +added / −removed / files / traces counted for that day.
  await chart.locator('svg > g').last().hover()
  const tip = page.locator('[data-testid=code-changes-tooltip]')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('Added: +')
  await expect(tip).toContainText('Removed: −')
  await expect(tip).toContainText('Files changed:')
  await expect(tip).toContainText('2 traces counted')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  expect(overflow, 'document overflow').toBe(false)

  // Only traces without line data: empty state, still saying how many were left out.
  await load(page, withChanges.slice(12))
  await expect(page.locator('[data-testid=code-changes-empty]')).toBeVisible()
  await expect(chart).toHaveCount(0)
  await expect(page.locator('[data-testid=code-changes-note]')).toContainText('2 traces without change data not counted')
  expect(errors, 'browser errors').toEqual([])
})
