import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Analytics › Agents renders one comparison column per agent with traces in view (all five sources,
 * not just Copilot/Claude/Codex), and the table scrolls in its own box rather than widening the
 * page on every project (desktop and mobile, light and dark; playwright.config.ts).
 */
const SOURCES = ['copilot', 'claude_code', 'codex', 'opencode', 'cursor']

test('agent comparison shows a column for each of the five agents and fits the viewport', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Cursor CLI records no token counts — its fixtures carry none, as real ones do.
  const fiveAgents = sessions.map((s, i) => {
    const source = SOURCES[i % SOURCES.length]
    return source === 'cursor'
      ? { ...s, source, model: '', inputTokens: 0, outputTokens: 0 }
      : { ...s, source }
  })

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    (sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'),
    fiveAgents,
  )
  await page.locator('#sessions-content tbody tr').first().waitFor()
  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()

  await page.locator('.view-nav-rail [data-view=agents]').click()

  const heads = page.locator('[data-testid=agent-comparison] th[data-agent-card]')
  await expect(heads).toHaveCount(5)
  expect(await heads.evaluateAll((els) => els.map((el) => el.getAttribute('data-agent-card')))).toEqual(SOURCES)
  await expect(heads).toHaveText(['Copilot', 'Claude', 'Codex', 'OpenCode', 'Cursor'])
  // No token data reads as missing, not as zero.
  const row = (label: string) => page.locator('[data-testid=agent-comparison] tbody tr').filter({ has: page.locator('th', { hasText: new RegExp(`^${label}$`) }) })
  await expect(row('Input tokens').locator('td[data-agent=cursor]')).toHaveText('—')
  await expect(row('Cache hit').locator('td[data-agent=cursor]')).toHaveText('—')
  await expect(row('Traces').locator('td[data-agent=copilot]')).not.toHaveText('—')

  const layout = await page.evaluate(() => {
    const opencode = document.querySelector('th[data-agent-card=opencode]') as HTMLElement
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      // OpenCode's accent is the theme foreground, never a literal white that vanishes on a light page.
      opencodeAccent: getComputedStyle(opencode).borderTopColor,
      pageBackground: getComputedStyle(document.body).backgroundColor,
    }
  })
  expect(layout.overflow, 'document overflow').toBe(false)
  expect(layout.opencodeAccent).not.toBe(layout.pageBackground)
  expect(errors, 'browser errors').toEqual([])
})
