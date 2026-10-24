import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * One colour per agent (media/src/agentColors.ts), from the theme's chart palette: the same
 * colour on the filter pill, the Analytics agent card and the cost chart legend; five distinct
 * colours; and none that disappears on the page background (OpenCode's white and Codex's neon
 * yellow used to, on a light theme).
 */
const SOURCES = ['copilot', 'claude_code', 'codex', 'opencode', 'cursor'] as const
const LABELS: Record<string, string> = { copilot: 'Copilot', claude_code: 'Claude', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor' }

function luminance(rgb: string): number {
  const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('each agent has one theme-aware colour across pills, cards and the cost legend', async ({ page }) => {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  const all = sessions.map((s, i) => ({ ...s, source: SOURCES[i % SOURCES.length] }))
  await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), all)
  await page.locator('#sessions-content tbody tr').first().waitFor()

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const pillColor: Record<string, string> = {}
  for (const src of SOURCES) {
    const pill = page.locator('.tr-agent-filter').getByRole('button', { name: LABELS[src], exact: true })
    pillColor[src] = await pill.evaluate((el) => getComputedStyle(el).borderTopColor)
  }
  // Five different colours, each readable against the page.
  expect(new Set(Object.values(pillColor)).size).toBe(SOURCES.length)
  for (const src of SOURCES) {
    expect(contrast(pillColor[src], bg), `${src} ${pillColor[src]} on ${bg}`).toBeGreaterThanOrEqual(2.5)
  }

  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  for (const src of SOURCES) {
    const card = page.locator(`[data-agent-card=${src}]`)
    await expect(card).toBeVisible()
    expect(await card.evaluate((el) => getComputedStyle(el).borderLeftColor)).toBe(pillColor[src])
  }
  const legend = page.locator('[data-testid=cost-chart-legend]')
  await expect(legend).toBeVisible()
  for (const src of SOURCES.filter((s) => s !== 'cursor')) {
    const swatch = legend.locator('span', { hasText: LABELS[src] }).first().locator('span[aria-hidden=true]')
    expect(await swatch.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(pillColor[src])
  }
})
