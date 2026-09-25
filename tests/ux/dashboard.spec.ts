import { test, expect } from '@playwright/test'
import { formatTraceIdHash } from '../../media/src/hash'
import { sessions } from './fixtures'

/**
 * Exercises the shipped dashboard bundle (media/src/dashboard.tsx) against synthetic fixture
 * data, in a real browser, across four viewport/theme combinations (playwright.config.ts's
 * `projects`) — no standalone server, log readers, agent configuration, or account access. Ported
 * from the former tests/ux/evaluate.mjs into a normal Playwright test so each project gets its
 * own isolated run, retries, and an HTML report instead of one script that aborts on the first
 * failed assertion.
 */

test('renders, searches, filters, and sorts traces without layout jitter or overflow', async (
  { page },
  testInfo,
) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    (sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'),
    sessions,
  )
  await page.locator('#sessions-content tbody tr').first().waitFor()

  // The Traces tab search field (#tr-filter-prompt) matches prompt text, the raw Trace ID, and
  // the normalized display hash shown/copied from a trace's expanded detail — a pasted value
  // from any of those three should find the trace (media/src/state.ts, hash.ts). Runs before the
  // geometry watch below: collapsing to a single matching row is a legitimate, large reflow (not
  // animation jitter) that the stationary-elements check isn't meant to catch.
  const searchInput = () => page.getByPlaceholder('Text or Trace ID')
  await searchInput().fill('Task 01')
  await expect(page.locator('#sessions-content tbody tr')).toHaveCount(1)

  await searchInput().fill('trace-63')
  await expect(page.locator('#sessions-content tbody tr')).toHaveCount(1)

  await searchInput().fill(formatTraceIdHash('trace-63'))
  await expect(page.locator('#sessions-content tbody tr')).toHaveCount(1)

  await searchInput().fill('no-matching-trace')
  await expect(page.locator('#sessions-content tbody')).toContainText(/No traces match/)

  await searchInput().fill('')
  await page.locator('#sessions-content tbody tr').first().waitFor()
  await page.screenshot({
    path: testInfo.outputPath('traces.png'),
    fullPage: true,
  })

  // Sample every animation frame, including transient movement, not just final state.
  // .trace-pagination is deliberately excluded: it sits in normal flow below the trace table, so
  // its y-position tracks the table's height, which itself tracks the filtered row count — the
  // filter/repo/time-range interactions below legitimately shrink or grow that count, and that's
  // reflow, not jank. Everything else here sits above/beside the variable content and must stay
  // put regardless of how many rows are filtered in or out.
  // .tr-trailing-controls (Clear Filters + paging, at the end of .time-range-bar) is excluded
  // too: a "Refreshing" spinner mounts/unmounts right before it while the 24h/All time-range
  // buttons below are in flight, nudging it sideways on narrow (flex-wrap) viewports — expected
  // reflow from a real, momentary loading state, not jank.
  // .tr-time-popover (the Time control's own preset/custom-range popover, App.tsx's
  // TimeRangeMenu) is excluded for the same reason: it only exists while a user has it open, and
  // this test opens it to click "24h"/"All" below — real, expected motion, not jank. The
  // popover's own fixed-width trigger (.time-range-bar summary) is still tracked, since that one
  // really must stay put regardless of which range is selected.
  await page.evaluate(() => {
    const elements = [
      ...document.querySelectorAll(
        '.tabs, .time-range-bar, .search-filter-controls, #sessions-content th, .time-range-bar summary, .time-range-bar button, .search-filter-controls button, .search-filter-controls input, .search-filter-controls select',
      ),
    ].filter((el) => !el.closest('.tr-trailing-controls') && !el.closest('.tr-time-popover'))
    function rect(el: Element) {
      const box = el.getBoundingClientRect().toJSON()
      // User-initiated scrolling to reach offscreen controls is intentional. Compare content
      // coordinates; resizing/reflow still fails this check.
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        box.x += parent.scrollLeft
        box.y += parent.scrollTop
      }
      return box
    }
    const initial = elements.map(rect)
    ;(window as any).uxGeometry = { max: 0, frames: 0, running: true, missing: 0 }
    function frame() {
      const geometry = (window as any).uxGeometry
      elements.forEach((el, i) => {
        if (!el.isConnected) {
          geometry.missing++
          return
        }
        const r = rect(el)
        for (const key of ['x', 'y', 'width', 'height'] as const)
          geometry.max = Math.max(geometry.max, Math.abs((r as any)[key] - (initial[i] as any)[key]))
      })
      geometry.frames++
      if (geometry.running) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })

  // Existing accessible surfaces, so this also reproduces failures on the original code.
  await page.locator('#sessions-content th').filter({ hasText: 'Tokens' }).getByRole('button').click()
  await page.waitForTimeout(100)
  await page.locator('#sessions-content th').filter({ hasText: 'Tokens' }).getByRole('button').click()
  await page.waitForTimeout(100)
  await expect(page.locator('th[aria-sort=ascending]')).toHaveCount(1)

  for (const name of ['Claude', 'Codex', 'All']) {
    await page
      .locator('.time-range-bar')
      .getByRole('button', { name, exact: true })
      .last()
      .click()
    await page.waitForTimeout(100)
  }
  for (const title of [
    'Log-file traces only',
    'Show all data sources',
    'Agent-spawned sub-tasks and non-interactive claude -p calls',
  ]) {
    await page.getByTitle(title, { exact: true }).click()
    await page.waitForTimeout(100)
  }
  // "Show all traces" also titles the Outcome filter's own All pill, so scope to the last match —
  // the From/initiator row's All pill, reset here after the toggle above.
  await page.getByTitle('Show all traces', { exact: true }).last().click()
  await page.waitForTimeout(100)

  // The project/workspace filter is now a freeform "Repo" input (matchesRepoQuery,
  // media/src/state.ts), not a <select> — it falls back to a plain path substring match here
  // since these fixtures have no resolvable repoInfo.
  await page.getByLabel('Repo', { exact: true }).fill('cloud')
  await page.waitForTimeout(100)
  await expect(page.locator('#sessions-content tbody tr').first()).toBeVisible()

  await page.getByLabel('Repo', { exact: true }).fill('')

  // Time presets moved into a popover (TimeRangeMenu, App.tsx) so a custom range never widens the
  // filter bar — open its <summary> trigger before each preset click, since choosing one closes
  // the popover again (mirrors a real user's click-to-pick gesture).
  for (const label of ['24h', 'All']) {
    await page.locator('.time-range-bar summary').click()
    await page
      .locator('.time-range-bar')
      .getByRole('button', { name: label, exact: true })
      .first()
      .click()
    await page.waitForTimeout(400)
  }

  await page.evaluate(
    (sessions) =>
      window.postMessage(
        {
          type: 'update',
          sessionSummary: { sessions: sessions.map((s) => ({ ...s, inputTokens: s.inputTokens * 1000 })) },
        },
        '*',
      ),
    sessions,
  )
  await page.waitForTimeout(100)

  const geometry = await page.evaluate(() => {
    const g = (window as any).uxGeometry
    g.running = false
    return g as { max: number; frames: number; missing: number }
  })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)

  const tabs: string[] = []
  for (const label of ['Analytics', 'Advisor', 'Export', 'Import', 'Traces']) {
    await page.locator('.tabs').getByRole('button', { name: label, exact: true }).click()
    await page.waitForTimeout(100)
    await page.screenshot({
      path: testInfo.outputPath(`${label.toLowerCase()}.png`),
      fullPage: true,
    })
    tabs.push(label)
  }

  await page.getByRole('button', { name: 'Expand trace', exact: true }).first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Collapse trace', exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Collapse trace', exact: true }).press('Enter')

  await testInfo.attach('result', {
    body: JSON.stringify({ mode: testInfo.project.name, geometry, overflow, errors, tabs }, null, 2),
    contentType: 'application/json',
  })

  expect(overflow, 'document overflow').toBe(false)
  expect(errors, 'browser errors').toEqual([])
  expect(geometry.missing, 'stationary elements were removed').toBe(0)
  expect(geometry.frames).toBeGreaterThan(2)
  expect(geometry.max, `${geometry.max}px jitter`).toBeLessThanOrEqual(1)
})
