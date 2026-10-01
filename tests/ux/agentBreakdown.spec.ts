import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Analytics → Agent breakdown renders one card per agent with traces in view — all five sources,
 * not just Copilot/Claude/Codex — and the row of five still fits the viewport on every project
 * (desktop and mobile, light and dark; playwright.config.ts).
 */
const SOURCES = ['copilot', 'claude_code', 'codex', 'opencode', 'cursor']

test('agent breakdown shows a card for each of the five agents and fits the viewport', async ({ page }) => {
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

  const cards = page.locator('#analytics-agent-breakdown + div [data-agent-card]')
  await expect(cards).toHaveCount(5)
  expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-agent-card')))).toEqual(SOURCES)
  for (const label of ['Copilot', 'Claude', 'Codex', 'OpenCode', 'Cursor']) {
    await expect(page.locator('[data-agent-card]').filter({ hasText: label })).toHaveCount(1)
  }
  // No token data reads as missing, not as zero.
  await expect(page.locator('[data-agent-card=cursor]')).toContainText('Input tokens —')
  await expect(page.locator('[data-agent-card=cursor]')).toContainText('Cache hit —')

  const layout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-agent-card]')] as HTMLElement[]
    const opencode = document.querySelector('[data-agent-card=opencode]') as HTMLElement
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      offscreen: cards.filter((c) => c.getBoundingClientRect().right > innerWidth + 0.5).length,
      // OpenCode's accent is the theme foreground, never a literal white that vanishes on a light page.
      opencodeAccent: getComputedStyle(opencode).borderLeftColor,
      pageBackground: getComputedStyle(document.body).backgroundColor,
    }
  })
  expect(layout.overflow, 'document overflow').toBe(false)
  expect(layout.offscreen, 'cards past the right edge').toBe(0)
  expect(layout.opencodeAccent).not.toBe(layout.pageBackground)
  expect(errors, 'browser errors').toEqual([])
})
