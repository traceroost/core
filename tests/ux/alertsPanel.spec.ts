import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The header bell opens the Alerts panel (media/src/AlertsPanel.tsx): Active / Configure /
 * Automation tabs in a slide-in drawer, replacing the bell's old popover and the Alerts and
 * Automation sections that used to sit in the Settings drawer.
 */

// One trace with enough errors to trip Error Spike (a per-trace alert, so it links to the trace).
const withErrors = sessions.map((s, i) => (i === 3 ? { ...s, errors: 12 } : s))

async function load(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), withErrors)
  await page.locator('#sessions-content tbody tr').first().waitFor()
}

test('the bell opens the Alerts panel; View trace closes it and opens the trace', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await load(page)

  const bell = page.locator('.tabs-icons').getByRole('button', { name: /^Alerts/ })
  await bell.click()
  const panel = page.getByRole('dialog', { name: 'Alerts' })
  await expect(panel).toBeVisible()
  await expect(bell).toHaveAttribute('aria-expanded', 'true')
  const active = panel.getByRole('tab', { name: /^Active/ })
  await expect(active).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('list', { name: 'Triggered alerts' })).toContainText('Error Spike')
  await page.waitForTimeout(300) // the drawer's 0.2s slide-in
  await page.screenshot({ path: testInfo.outputPath('alerts-active.png') })

  await panel.getByRole('button', { name: 'View trace →' }).first().click()
  await expect(panel).toBeHidden()
  await expect(page.locator('.tabs').getByRole('button', { name: 'Traces', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Collapse trace', exact: true })).toHaveCount(1)
  expect(errors).toEqual([])
})

test('Alerts panel tabs work from the keyboard; Escape closes it and returns focus to the bell', async ({ page }, testInfo) => {
  await load(page)
  const bell = page.locator('.tabs-icons').getByRole('button', { name: /^Alerts/ })
  await bell.focus()
  await page.keyboard.press('Enter')
  const panel = page.getByRole('dialog', { name: 'Alerts' })
  await expect(panel).toBeVisible()
  // Focus moves into the panel on open.
  await expect(panel.getByRole('button', { name: 'Close alerts' })).toBeFocused()

  await panel.getByRole('tab', { name: /^Active/ }).focus()
  await page.keyboard.press('ArrowRight')
  const configure = panel.getByRole('tab', { name: 'Configure' })
  await expect(configure).toHaveAttribute('aria-selected', 'true')
  await expect(configure).toBeFocused()
  await expect(panel.locator('#alerts-content')).toBeVisible()
  await expect(panel.getByRole('checkbox', { name: 'Error Spike alert enabled' })).toHaveCount(1)
  await page.waitForTimeout(300) // the drawer's 0.2s slide-in
  await page.screenshot({ path: testInfo.outputPath('alerts-configure.png') })

  await page.keyboard.press('ArrowRight')
  await expect(panel.getByRole('tab', { name: 'Automation' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator('#automation-content')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(bell).toBeFocused()
})

test('Settings no longer holds Alerts or Automation', async ({ page }) => {
  await load(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await expect(settings.locator('#alerts-content, #automation-content')).toHaveCount(0)
  await expect(settings.getByRole('button', { name: 'Alerts', exact: true })).toHaveCount(0)
})

test('"View Alert" from a notification opens the Configure tab at that alert', async ({ page }) => {
  await load(page)
  await page.evaluate(() => window.postMessage({ type: 'switchTab', tab: 'alerts', anchor: 'tool_loop' }, '*'))
  const panel = page.getByRole('dialog', { name: 'Alerts' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('tab', { name: 'Configure' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator('#alert-card-tool_loop')).toBeInViewport()

  // An automation notification's "Configure" lands on the Automation tab.
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.postMessage({ type: 'switchTab', tab: 'settings-automation' }, '*'))
  await expect(panel.getByRole('tab', { name: 'Automation' })).toHaveAttribute('aria-selected', 'true')
})
