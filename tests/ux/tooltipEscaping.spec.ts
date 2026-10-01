import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The global tooltip (App.tsx) renders `data-tip-html` targets as markup. The git-outcome badge's
 * tooltip carries one non-static piece — the outcome's `reason`, which names the repo's trunk
 * branch, and a git ref name may contain `<`/`>` — so it must arrive escaped, never as elements.
 */
test('git-outcome badge tooltip shows the reason as text, not markup', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  const reason = '1 file(s) committed, but not yet merged into <img src=x onerror="window.__xss=1">'
  await page.evaluate(({ sessions, reason }) => {
    window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*')
    window.postMessage({
      type: 'gitOutcome', sessionId: sessions[0].sessionId,
      outcome: { overall: 'committed', files: {}, reason },
    }, '*')
  }, { sessions, reason })

  const badge = page.locator('#sessions-content tbody tr').first().locator('span[data-tip-html]', { hasText: /^C$/ })
  await badge.waitFor()
  await badge.dispatchEvent('mouseover')
  const tip = page.locator('.metric-tooltip')
  await expect(tip).toBeVisible()
  await expect(tip).toContainText('<img src=x')
  await expect(tip.locator('b')).toHaveText('Committed')
  expect(await tip.locator('img').count()).toBe(0)
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined()
  expect(errors).toEqual([])
})
