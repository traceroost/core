import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Changing the sort (a header click, or Reset) returns the Traces table to page 1 — the rows on
 * page 3 of the old order are an arbitrary slice of the new one. 64 fixture traces at the default
 * 20 per page is 4 pages.
 */
test('sorting returns the table to page 1', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), sessions)

  const pageInput = page.getByRole('spinbutton', { name: 'Jump to page' }).first()
  await expect(pageInput).toHaveValue('1')
  await page.getByRole('button', { name: 'Next ›' }).first().click()
  await page.getByRole('button', { name: 'Next ›' }).first().click()
  await expect(pageInput).toHaveValue('3')

  // A new column, then the same column again (direction flip): both go back to page 1.
  const turns = page.locator('#sessions-content thead th', { hasText: 'Turns' })
  await turns.click()
  await expect(pageInput).toHaveValue('1')
  await page.getByRole('button', { name: 'Next ›' }).first().click()
  await expect(pageInput).toHaveValue('2')
  await turns.click()
  await expect(turns).toHaveAttribute('aria-sort', 'ascending')
  await expect(pageInput).toHaveValue('1')

  expect(errors, 'browser errors').toEqual([])
})
