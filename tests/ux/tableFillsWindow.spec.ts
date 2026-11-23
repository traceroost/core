import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The Traces table's default page size, "Fit", shows as many rows as fit the window, so the pager
 * sits at the bottom of the tab with no empty band under the table and nothing to scroll. A resize
 * re-fits it.
 */

async function load(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), sessions)
  await expect(page.locator('#sessions-content tr.trace-row').first()).toBeVisible()
}

/** Gap between the table's pager and the bottom of the scroll region, and whether it scrolls. */
async function layout(page: Page) {
  await page.waitForTimeout(150) // the measurement runs on the next animation frame
  return page.evaluate(() => {
    const panel = document.querySelector('.panel.active') as HTMLElement
    const pager = document.querySelector('#sessions-content .trace-pagination') as HTMLElement
    const row = document.querySelector('#sessions-content tr.trace-row') as HTMLElement
    return {
      rows: document.querySelectorAll('#sessions-content tr.trace-row').length,
      gap: panel.getBoundingClientRect().bottom - pager.getBoundingClientRect().bottom,
      rowHeight: row.getBoundingClientRect().height,
      scrolls: panel.scrollHeight > panel.clientHeight + 1,
    }
  })
}

test('the default page fills the window: no empty band under the pager, nothing to scroll', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('mobile'), 'phone widths scroll the table sideways, which changes the measure')
  await load(page)
  const l = await layout(page)
  expect(l.rows).toBeGreaterThan(20)
  expect(l.scrolls, JSON.stringify(l)).toBe(false)
  expect(l.gap, JSON.stringify(l)).toBeGreaterThanOrEqual(0)
  expect(l.gap, JSON.stringify(l)).toBeLessThan(l.rowHeight + 8)
  await expect(page.getByRole('combobox').filter({ hasText: 'Fit:' }).first()).toBeVisible()
})

test('resizing the window re-fits the page', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('mobile'), 'phone widths scroll the table sideways, which changes the measure')
  await load(page)
  const tall = await layout(page)
  await page.setViewportSize({ width: 1440, height: 640 })
  const short = await layout(page)
  expect(short.rows).toBeLessThan(tall.rows)
  expect(short.scrolls, JSON.stringify(short)).toBe(false)
  expect(short.gap, JSON.stringify(short)).toBeLessThan(short.rowHeight + 8)
})

test('a fixed page size still shows exactly that many rows', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('mobile'), 'covered on desktop widths')
  await load(page)
  await page.locator('#sessions-content .trace-pagination select').selectOption('50')
  await expect(page.locator('#sessions-content tr.trace-row')).toHaveCount(50)
})
