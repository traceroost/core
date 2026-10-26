import { test, expect, type Page } from '@playwright/test'
import { sessions as baseSessions } from './fixtures'

/**
 * Every signal glyph sits in the same rounded tile (signalIcons.tsx's SignalBadge, `.sig-badge`
 * in styles/base.css): critical = solid tile, warning = tinted tile, neutral = faint tint. These
 * check that the Traces Signals column, the expanded trace, the Advisor and Help all draw that one
 * tile, that severities differ only by modifier class, and that the glyph stays legible against
 * its tile in each theme.
 */

const sig = (type: string, severity: 'warning' | 'critical', patternName: string) => ({
  type, severity, patternName, evidence: `${patternName} evidence`, count: 2, examples: [],
  action: `Do something about ${patternName}.`, trigger: `${patternName} trigger`,
})

const sessions = baseSessions.map((s, i) => {
  if (i === 0) {
    return {
      ...s,
      loopSignals: [
        sig('runaway_steps', 'critical', 'Ambiguous Success'),
        sig('context_flooding_risk', 'warning', 'Context Flooding Risk'),
        sig('token_runaway', 'warning', 'Context Runaway'),
        sig('file_reread', 'warning', 'Redundant Context Reload'),
        sig('chronic_tool_failures', 'warning', 'Chronic Tool Unreliability'),
      ],
    }
  }
  if (i === 1) return { ...s, loopSignals: [sig('edit_revert_cycle', 'warning', 'Edit Reverted')] }
  if (i === 2) return { ...s, loopSignals: [sig('error_recurrence', 'critical', 'Repeated Error')] }
  return s
})

async function load(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    (sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'),
    sessions,
  )
  await page.locator('#sessions-content tbody tr').first().waitFor()
}

/** WCAG contrast of an element's text colour against its own (possibly translucent) background,
 *  composited over the page background. */
async function glyphContrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((selector) => {
    const parse = (c: string): number[] => {
      const n = c.match(/[\d.]+/g)!.map(Number)
      // rgb()/rgba() are 0-255; color(srgb r g b / a) is 0-1.
      if (c.startsWith('color(')) return [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1]
      return [n[0], n[1], n[2], n[3] ?? 1]
    }
    const over = (top: number[], under: number[]) => [0, 1, 2].map(k => top[k] * top[3] + under[k] * (1 - top[3])).concat(1)
    const lum = (c: number[]) => {
      const [r, g, b] = c.slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const el = document.querySelector(selector)!
    const page = parse(getComputedStyle(document.body).backgroundColor)
    const tile = over(parse(getComputedStyle(el).backgroundColor), page)
    const glyph = over(parse(getComputedStyle(el).color), tile)
    const [a, b] = [lum(tile), lum(glyph)].sort((x, y) => y - x)
    return (a + 0.05) / (b + 0.05)
  }, selector)
}

test('signal icons share one tile across the dashboard, differing only by severity modifier', async (
  { page },
  testInfo,
) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await load(page)

  // Traces table: 3 tiles then "+2", worst severity first.
  const cell = page.locator('#sessions-content tbody tr').first().locator('.sig-cell')
  const tiles = cell.locator('.sig-badge')
  await expect(tiles).toHaveCount(3)
  await expect(cell.locator('.sig-more')).toHaveText('+2')
  await expect(tiles.nth(0)).toHaveClass('sig-badge critical sm')
  await expect(tiles.nth(1)).toHaveClass('sig-badge warning sm')
  await expect(tiles.nth(2)).toHaveClass('sig-badge warning sm')
  // Tooltip, label and focus behaviour unchanged by the new wrapper.
  await expect(tiles.nth(0)).toHaveAttribute('role', 'img')
  await expect(tiles.nth(0)).toHaveAttribute('tabindex', '0')
  await expect(tiles.nth(0)).toHaveAttribute('data-tip-html', /.*/)
  await expect(tiles.nth(0)).toHaveAttribute('aria-label', /^Ambiguous Success \(critical\)/)

  const box = async (i: number) => (await tiles.nth(i).boundingBox())!
  const [crit, warn] = [await box(0), await box(1)]
  expect(warn.width).toBe(crit.width)
  expect(warn.height).toBe(crit.height)
  const radius = (sel: string) => page.locator(sel).first().evaluate(el => getComputedStyle(el).borderRadius)
  expect(await radius('.sig-cell .sig-badge.warning')).toBe(await radius('.sig-cell .sig-badge.critical'))
  expect(await radius('.sig-cell .sig-more')).toBe(await radius('.sig-cell .sig-badge.critical'))
  expect((await cell.locator('.sig-more').boundingBox())!.height).toBe(crit.height)
  // All three tiles and the "+N" fit inside the Signals column without spilling over.
  const td = cell.locator('xpath=ancestor::td[1]')
  const tdBox = (await td.boundingBox())!
  const moreBox = (await cell.locator('.sig-more').boundingBox())!
  expect(moreBox.x + moreBox.width).toBeLessThanOrEqual(tdBox.x + tdBox.width - 2) // inside the cell's 2px right padding

  expect(await glyphContrast(page, '.sig-cell .sig-badge.critical')).toBeGreaterThanOrEqual(3)
  expect(await glyphContrast(page, '.sig-cell .sig-badge.warning')).toBeGreaterThanOrEqual(3)
  await page.locator('#sessions-content table').screenshot({ path: testInfo.outputPath('traces-signals.png') })

  // Expanded trace: the Overview's Signals list and its Insights cards use md tiles.
  await page.getByRole('button', { name: 'Expand trace', exact: true }).first().click()
  const expanded = page.locator('#sessions-content tbody')
  await expect(expanded.locator('.sig-badge.md.critical').first()).toBeVisible()
  await expect(expanded.locator('.sig-badge.md.warning').first()).toBeVisible()
  await page.waitForTimeout(200)
  await page.screenshot({ path: testInfo.outputPath('trace-overview.png'), fullPage: true })

  // Advisor: loop-signal actions get the same tile.
  await page.locator('.tabs').getByRole('button', { name: 'Advisor', exact: true }).click()
  const advisor = page.locator('#advisor-save-money')
  await expect(advisor.locator('.sig-badge.md').first()).toBeVisible()
  await advisor.screenshot({ path: testInfo.outputPath('advisor.png') })

  // Help: one-line legend plus a neutral tile on every glossary entry.
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  const help = page.locator('#help-signals')
  await expect(help.locator('.sig-legend .sig-badge.critical')).toHaveCount(1)
  await expect(help.locator('.sig-legend .sig-badge.warning')).toHaveCount(1)
  const glossaryTiles = help.locator('.glossary .sig-badge')
  expect(await glossaryTiles.count()).toBeGreaterThan(10)
  expect(await glossaryTiles.evaluateAll(els => els.every(el => el.classList.contains('neutral')))).toBe(true)
  expect(await glyphContrast(page, '#help-signals .sig-legend .sig-badge.critical')).toBeGreaterThanOrEqual(3)
  expect(await glyphContrast(page, '#help-signals .sig-legend .sig-badge.warning')).toBeGreaterThanOrEqual(3)
  await help.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('help-signals.png') })

  expect(errors, 'browser errors').toEqual([])
})
