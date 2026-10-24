import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The filter bar keeps Time and Agent in view; Prompt, Language, Repo, Outcome, Source and From
 * sit behind a "Filters (n)" button (App.tsx's FiltersControl), with the active ones as removable
 * chips beside it.
 */

async function load(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), sessions)
  await page.locator('#sessions-content tbody tr').first().waitFor()
}

test('secondary filters live in the Filters popover; chips show and remove them', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await load(page)
  const bar = page.locator('.time-range-bar')
  const rows = page.locator('#sessions-content tbody tr')

  // Time and Agent stay in the bar; the rest are behind the button.
  await expect(bar.locator('summary')).toBeVisible()
  await expect(bar.locator('.tr-agent-filter')).toBeVisible()
  for (const id of ['#tr-filter-prompt', '#tr-filter-language', '#tr-filter-repo']) await expect(page.locator(id)).toHaveCount(0)
  const button = bar.getByRole('button', { name: /^Filters/ })
  await expect(button).toHaveText(/^Filters\s*▾$/)
  await expect(button).toHaveAttribute('aria-expanded', 'false')

  // Opens from the keyboard, with focus moved inside.
  await button.focus()
  await page.keyboard.press('Enter')
  const popover = page.getByRole('dialog', { name: 'Filters' })
  await expect(popover).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(popover.getByRole('button', { name: 'Close filters' })).toBeFocused()
  for (const label of ['Prompt', 'Language', 'Repo', 'Outcome', 'Source', 'From']) {
    await expect(popover.getByText(label, { exact: true })).toBeVisible()
  }

  // Fits the viewport at any width.
  const box = (await popover.boundingBox())!
  const width = page.viewportSize()!.width
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(width)

  await popover.getByRole('group', { name: 'Source' }).getByRole('button', { name: 'Log' }).click()
  await popover.getByRole('group', { name: 'From' }).getByRole('button', { name: 'Agent' }).click()
  await popover.getByLabel('Prompt').fill('Implement')
  await page.waitForTimeout(300) // let the inputs settle before the screenshot
  await page.screenshot({ path: testInfo.outputPath('filters-popover.png') })

  // Escape closes it and hands focus back to the button, which now counts the active filters.
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(button).toBeFocused()
  await expect(button).toHaveText(/^Filters \(3\)/)
  const chips = bar.locator('.tr-filter-chip')
  await expect(chips).toHaveText(['Prompt: Implement×', 'Source: Log×', 'From: Agent×'])
  // Log and "Implement" are the odd ids; From: Agent keeps agent- and API-initiated traces
  // (i % 3 !== 0) — 21 of the 32 odd ids.
  await expect(page.getByText('Showing 1–20 of 21')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('filters-chips.png') })

  // A chip's × removes just that filter.
  await bar.getByRole('button', { name: 'Remove Source filter' }).click()
  await expect(button).toHaveText(/^Filters \(2\)/)
  await expect(chips).toHaveText(['Prompt: Implement×', 'From: Agent×'])

  // Clear Filters still resets everything.
  await page.getByRole('button', { name: 'Clear Filters' }).click()
  await expect(chips).toHaveCount(0)
  await expect(button).toHaveText(/^Filters\s*▾$/)
  await expect(rows).toHaveCount(20)
  expect(errors).toEqual([])
})

test('clicking outside the Filters popover closes it', async ({ page }) => {
  await load(page)
  await page.getByRole('button', { name: /^Filters/ }).click()
  const popover = page.getByRole('dialog', { name: 'Filters' })
  await expect(popover).toBeVisible()
  await page.mouse.click(5, page.viewportSize()!.height - 5)
  await expect(popover).toHaveCount(0)
})
