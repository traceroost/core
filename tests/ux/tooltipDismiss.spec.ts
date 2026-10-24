import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Escape dismisses the global tooltip (App.tsx) without moving the pointer (WCAG 1.4.13). The
 * dismissed element must still show its styled tooltip next time it is hovered — it used to stay
 * the "active" target forever, so it never showed again.
 */
test('a tooltip dismissed with Escape shows again on the next hover', async ({ page }) => {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(({ sessions }) => {
    window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*')
    window.postMessage({
      type: 'gitOutcome', sessionId: sessions[0].sessionId,
      outcome: { overall: 'committed', files: {}, reason: '1 file(s) committed' },
    }, '*')
  }, { sessions })

  const badge = page.locator('#sessions-content tbody tr').first().locator('span[data-tip-html]', { hasText: /^C$/ })
  await badge.waitFor()
  const tip = page.locator('.metric-tooltip')

  await badge.dispatchEvent('mouseover')
  await expect(tip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tip).toBeHidden()

  // Still hovering (another mouseover from inside it): stays dismissed.
  await badge.dispatchEvent('mouseover')
  await page.waitForTimeout(300)
  await expect(tip).toBeHidden()

  // Leave, come back: shows again.
  await badge.dispatchEvent('mouseout')
  await badge.dispatchEvent('mouseover')
  await expect(tip).toBeVisible()
})
