/**
 * The guided tab tour — shared by `demo/browser.ts` (interactive, headed) and
 * `demo/capture-gif.ts` (records it to video). One sequence, one place to tune pause
 * lengths, so the two never drift apart.
 *
 * The real top-level tab bar (media/src/App.tsx TABS) — sessions/analytics/patterns,
 * selected via `button[data-tab="${id}"]`. A previous version of this
 * list (efficiency/tokens/files/summaries/recommendations/errors/agents/timeline/
 * traces/latency/tools/automation) didn't match any current `data-tab` value, so
 * every step's isVisible() check silently failed and the tour clicked nothing at
 * all — none of those are top-level tabs; most are sections *inside* Sessions'
 * expand-in-place detail view or Analytics' scrolling page, and Automation/Alerts
 * live in the Alerts panel behind the header bell. See tourSessionDetail() and
 * tourAlertsPanel() below for those.
 */

export interface TourTab {
  id: string
  label: string
  pauseMs: number
}

// `id` stays 'sessions' — the internal data-tab value never changed, only the visible label
// (see media/src/App.tsx's own comment on its TABS array). Kept in sync here so the log text
// matches what's actually on screen.
export const TOUR_TABS: TourTab[] = [
  { id: 'sessions',  label: 'Traces',    pauseMs: 3000 },
  { id: 'analytics', label: 'Analytics', pauseMs: 5000 },
  { id: 'patterns',  label: 'Advisor',   pauseMs: 5000 },
]

type Page = import('playwright').Page
type Logger = (msg: string) => void

// Expands the most recent session (Sessions tab's expand-in-place row) and walks its
// internal Overview/Waterfall/Flow/Tools/Files nav — these are plain buttons with no
// data-tab attribute, so matched by accessible name instead. Counts like "Trace (12)"
// are appended dynamically, hence the regex match rather than exact text.
export async function tourSessionDetail(page: Page, speed: number, log: Logger): Promise<void> {
  const rows = page.locator('#sessions-content table tbody tr')
  try {
    await rows.first().waitFor({ state: 'visible', timeout: 15000 })
  } catch {
    log('  (no sessions rendered yet — skipping session detail walkthrough)')
    return
  }

  log('  → expanding most recent session')
  await rows.first().click()
  await page.waitForTimeout(600 / speed)

  const sections: Array<{ name: RegExp; label: string }> = [
    { name: /^Overview$/,  label: 'Overview' },
    { name: /^Waterfall/,  label: 'Waterfall' },
    { name: /^Flow/,       label: 'Flow' },
    { name: /^Tools/,      label: 'Tools' },
    { name: /^Files/,      label: 'Files' },
  ]
  // role="tab", not "button" — the detail nav became a real tablist in 255e38b (2026-10-23,
  // "dialog semantics for drawers"). This loop asked for role 'button' until 2026-11-08, so
  // every isVisible() check failed and the tour expanded a row and then showed only Overview:
  // the same silent-skip the header comment above describes, in a second place. Hence the
  // loud log on a miss — a skipped section must never again look like a successful run.
  const detail = page.locator('#sessions-content')
  for (const { name, label } of sections) {
    const tab = detail.getByRole('tab', { name })
    const visible = await tab.first().isVisible().catch(() => false)
    if (!visible) {
      log(`  ! session detail: ${label} not found — section SKIPPED (check its role/name)`)
      continue
    }
    await tab.first().click()
    log(`  → session detail: ${label} (2.5s)`)
    await page.waitForTimeout(2500 / speed)
  }

  // Collapse — click the same row again
  await rows.first().click()
  await page.waitForTimeout(300 / speed)
}

// Automation and Alerts aren't top-level tabs — they live in the Alerts panel behind the
// header bell (App.tsx BellButton, media/src/AlertsPanel.tsx). Its accessible name starts
// "Alerts" (followed by the triggered count, when there is one).
export async function tourAlertsPanel(page: Page, speed: number, log: Logger): Promise<void> {
  const bell = page.locator('.tabs-icons').getByRole('button', { name: /^Alerts/ })
  const visible = await bell.isVisible().catch(() => false)
  if (!visible) return

  log('  → Alerts panel (Active, Configure, Automation — 6s)')
  await bell.click()
  const panel = page.getByRole('dialog', { name: 'Alerts' })
  await page.waitForTimeout(2000 / speed)
  for (const tab of ['Configure', 'Automation']) {
    await panel.getByRole('tab', { name: tab }).click().catch(() => {})
    await page.waitForTimeout(2000 / speed)
  }
  // Close via Escape, not a second click on the bell — the panel is a `position:fixed;
  // top:0; right:0` sheet that, once open, sits on top of the same top-right corner the
  // bell lives in, so a second click there hits the panel instead and Playwright
  // (correctly) refuses to click a different element than the one it resolved. Escape is
  // the panel's own documented close path (see its "×" button's title="Close (Esc)").
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300 / speed)
}

// Export isn't a tab any more — it became a drawer over the Traces table in 60a25a7
// ("Export and Import become drawers, not tabs"), opened by the "Export…" button in the filter
// row (App.tsx, rendered with the paging controls) and closed with Escape, like the Alerts
// panel. That commit dropped the old 'export'/'import' entries from TOUR_TABS without putting
// anything in their place, so the demo stopped showing the redacted export at all.
export async function tourExportDrawer(page: Page, speed: number, log: Logger): Promise<void> {
  const btn = page.getByRole('button', { name: /^Export…$/ })
  const visible = await btn.first().isVisible().catch(() => false)
  if (!visible) {
    log('  ! Export… button not visible — export drawer SKIPPED')
    return
  }

  log('  → Export drawer (scope, Redacted / Full — 4.5s)')
  await btn.first().click()
  const drawer = page.getByRole('dialog', { name: 'Export traces' })
  const opened = await drawer
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  // A drawer that never opened would record 4.5s of an unchanged table — which is exactly how
  // this stop first went wrong, and it looked like a clean run in the log. Say so instead.
  if (!opened) {
    const expanded = await btn.first().getAttribute('aria-expanded').catch(() => null)
    log(`  ! Export drawer never became visible (button aria-expanded=${expanded}) — stop is DEAD AIR`)
  }
  await page.waitForTimeout(4500 / speed)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600 / speed)
}

export interface RunTourOptions {
  speed: number
  log: Logger
  /** ms to wait before the first tab switch, letting the first batch of replayed spans land. */
  initialWaitMs?: number
}

/** Runs the full tour: waits for data, walks every tab in TOUR_TABS (with the Sessions
 *  detail nav and Alerts panel folded in at the right points), then returns to Sessions —
 *  the most useful default landing tab, and the frame a recording should end on. */
export async function runTour(page: Page, opts: RunTourOptions): Promise<void> {
  const { speed, log, initialWaitMs = 3000 } = opts
  await page.waitForTimeout(initialWaitMs)

  for (const { id, label, pauseMs } of TOUR_TABS) {
    const btn = page.locator(`button[data-tab="${id}"]`)
    const visible = await btn.isVisible().catch(() => false)
    if (!visible) continue

    await btn.click()
    log(`  → ${label} tab (${pauseMs / 1000}s)`)
    await page.waitForTimeout(pauseMs / speed)

    // Sessions: also expand a card and walk its Overview/Waterfall/Flow/Tools/Files
    // detail nav — those live inside the row, not the top-level tab bar.
    if (id === 'sessions') await tourSessionDetail(page, speed, log)

    // Analytics is the natural point to also surface Automation/Alerts, which
    // live in the Alerts panel (header bell) rather than a tab of their own.
    if (id === 'analytics') await tourAlertsPanel(page, speed, log)
  }

  // Return to Sessions after the tour — the most useful default landing tab.
  await page.locator('button[data-tab="sessions"]').click().catch(() => {})
  await page.waitForTimeout(800 / speed)

  // Export last, over the Traces table: the drawer reports how many traces match the current
  // filters, so it reads best once the whole replay has landed. Closing it leaves the recording
  // on the Traces table, the frame it should end on.
  await tourExportDrawer(page, speed, log)
}
