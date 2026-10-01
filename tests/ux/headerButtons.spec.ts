import { test, expect } from '@playwright/test'

/**
 * The header's icon-only buttons (App.tsx) draw just an SVG — each needs an accessible name of
 * its own, or a screen reader announces a row of unlabeled "button"s.
 */
test('header icon buttons have accessible names', async ({ page }) => {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  for (const name of ['Alerts', 'Action log', 'Settings', 'Pricing', 'Help']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
  }
  const help = page.getByRole('button', { name: 'Help', exact: true })
  await expect(help).toHaveAttribute('aria-pressed', 'false')
  await help.click()
  await expect(help).toHaveAttribute('aria-pressed', 'true')
})
