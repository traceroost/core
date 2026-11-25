import { test, expect, type Page } from '@playwright/test'
import { sessions as base } from './fixtures'

/**
 * Analytics › Efficiency's cost-vs-turns map (media/src/tabs/Efficiency.tsx): every dot draws the
 * same until a row in the table below is pointed at or focused, which lights that row's dot. The
 * table's sort never changes the map, and the map scales with its panel instead of clipping.
 */
const sessions = base.map((s, i) => ({ ...s, model: 'claude-sonnet-4-5', inputTokens: 20_000 + i * 997, totalLlmCalls: 1 + (i % 9) }))

async function openMap(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), sessions)
  await page.locator('#sessions-content tbody tr').first().waitFor()
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  await page.getByRole('navigation', { name: 'Analytics views' }).locator('[data-view=efficiency]').click()
  await page.locator('#analytics-efficiency-map svg').waitFor()
}

test('the map highlights only the trace pointed at in the table, whatever the sort', async ({ page }) => {
  await openMap(page)
  const map = page.locator('#analytics-efficiency-map')
  await expect(map.locator('circle[data-lit]')).toHaveCount(0)

  // Re-sorting the table leaves every dot as it was.
  await map.getByRole('button', { name: /Turns/ }).click()
  await expect(map.locator('circle[data-lit]')).toHaveCount(0)

  const row = map.locator('tbody tr').nth(2)
  const id = await row.getAttribute('data-trace-row')
  await row.hover()
  await expect(map.locator('circle[data-lit]')).toHaveCount(1)
  await expect(map.locator(`circle[data-trace-dot="${id}"]`)).toHaveAttribute('data-lit', 'true')

  // Keyboard focus inside a row does the same.
  await page.mouse.move(0, 0)
  await expect(map.locator('circle[data-lit]')).toHaveCount(0)
  await map.locator('tbody tr').nth(0).locator('button').first().focus()
  await expect(map.locator('circle[data-lit]')).toHaveCount(1)

  // The colour key says what the colours are.
  await expect(map).toContainText('Colour is prompt-cache reuse')
  await expect(map).not.toContainText('from scratch')
})

test('the map scales to a narrow panel instead of clipping', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 })
  await openMap(page)
  const svg = page.locator('#analytics-efficiency-map svg')
  await expect(svg).toHaveAttribute('viewBox', /^0 0 /)
  const box = await svg.boundingBox()
  const panel = await page.locator('#analytics-efficiency-map').boundingBox()
  expect(box!.width).toBeLessThanOrEqual(panel!.width + 1)
})
