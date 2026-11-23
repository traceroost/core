import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Analytics and Advisor each show one view at a time from a left menu (media/src/ViewNav.tsx), the
 * same structure as cloud's `?view=` pages. The menu items never change with the data, the chosen
 * view survives a reload, and the host's switchTab `anchor` opens a given view (the sidebar's plan
 * meters and the extension's advise deep links rely on it).
 */
const ANALYTICS = ['cost', 'output', 'efficiency', 'agents']
const ADVISOR = ['recommendations', 'instructions', 'results']

async function load(page: Page, data = sessions) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), data)
  await page.locator('#sessions-content tbody tr').first().waitFor()
}

const rail = (page: Page, label: string) => page.getByRole('navigation', { name: label })
const items = (page: Page, label: string) =>
  rail(page, label).locator('button[data-view]').evaluateAll((els) => els.map((el) => el.getAttribute('data-view')))

test('each tab lists fixed views and shows only the chosen one', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await load(page)

  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  expect(await items(page, 'Analytics views')).toEqual(ANALYTICS)
  // Opens on the first view, marked current, and nothing from the other views renders.
  await expect(rail(page, 'Analytics views').locator('[aria-current=page]')).toHaveAttribute('data-view', 'cost')
  await expect(page.locator('[data-view-panel]')).toHaveCount(1)
  await expect(page.locator('[data-view-panel=cost]')).toContainText('Cost & limits')
  // The fixtures have no plan data: Plan limits says why instead of vanishing.
  await expect(page.locator('#analytics-plan-limits')).toContainText('No plan usage recorded yet')

  for (const view of ANALYTICS) {
    await rail(page, 'Analytics views').locator(`[data-view=${view}]`).click()
    await expect(page.locator('[data-view-panel]')).toHaveCount(1)
    await expect(page.locator(`[data-view-panel=${view}]`)).toBeVisible()
  }
  // The Efficiency map and hot files moved here from Advisor.
  await rail(page, 'Analytics views').locator('[data-view=efficiency]').click()
  await expect(page.locator('#analytics-efficiency-map')).toBeVisible()
  await expect(page.locator('#analytics-hot-files')).toBeVisible()

  await page.locator('.tabs').getByRole('button', { name: 'Advisor', exact: true }).click()
  expect(await items(page, 'Advisor views')).toEqual(ADVISOR)
  await expect(rail(page, 'Advisor views').locator('[aria-current=page]')).toHaveAttribute('data-view', 'recommendations')
  await rail(page, 'Advisor views').locator('[data-view=results]').click()
  await expect(page.locator('[data-view-panel=results]')).toContainText('Nothing applied yet')

  // A filter that leaves one agent keeps every item in the menu.
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  await page.getByRole('button', { name: 'Copilot', exact: true }).first().click()
  expect(await items(page, 'Analytics views')).toEqual(ANALYTICS)

  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'document overflow').toBe(false)
  expect(errors, 'browser errors').toEqual([])
})

test('the chosen view survives a reload, and switchTab can open a given view', async ({ page }) => {
  await load(page)
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  await rail(page, 'Analytics views').locator('[data-view=output]').click()

  await load(page)
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(rail(page, 'Analytics views').locator('[aria-current=page]')).toHaveAttribute('data-view', 'output')

  await page.evaluate(() => window.postMessage({ type: 'switchTab', tab: 'patterns', anchor: 'results' }, '*'))
  await expect(page.locator('[data-view-panel=results]')).toBeVisible()
  await page.evaluate(() => window.postMessage({ type: 'switchTab', tab: 'analytics', anchor: 'cost' }, '*'))
  await expect(page.locator('[data-view-panel=cost]')).toBeVisible()
  // An unknown view just opens the tab where it was.
  await page.evaluate(() => window.postMessage({ type: 'switchTab', tab: 'patterns', anchor: 'nope' }, '*'))
  await expect(page.locator('[data-view-panel=results]')).toBeVisible()
})
