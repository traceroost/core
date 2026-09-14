/**
 * The guided tab tour — shared by `demo/browser.ts` (interactive, headed) and
 * `demo/capture-gif.ts` (records it to video). One sequence, one place to tune pause
 * lengths, so the two never drift apart.
 *
 * The real top-level tab bar (media/src/App.tsx TABS) — sessions/analytics/patterns/
 * export/import, selected via `button[data-tab="${id}"]`. A previous version of this
 * list (efficiency/tokens/files/summaries/recommendations/errors/agents/timeline/
 * traces/latency/tools/automation) didn't match any current `data-tab` value, so
 * every step's isVisible() check silently failed and the tour clicked nothing at
 * all — none of those are top-level tabs; most are sections *inside* Sessions'
 * expand-in-place detail view or Analytics' scrolling page, and Automation/Alerts
 * live in the Settings (gear) panel. See tourSessionDetail() and
 * tourSettingsPanel() below for those.
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
  { id: 'export',    label: 'Export',    pauseMs: 3000 },
  { id: 'import',    label: 'Import',    pauseMs: 3000 },
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
  const detail = page.locator('#sessions-content')
  for (const { name, label } of sections) {
    const btn = detail.getByRole('button', { name })
    const visible = await btn.first().isVisible().catch(() => false)
    if (!visible) continue
    await btn.first().click()
    log(`  → session detail: ${label} (2.5s)`)
    await page.waitForTimeout(2500 / speed)
  }

  // Collapse — click the same row again
  await rows.first().click()
  await page.waitForTimeout(300 / speed)
}

// Automation and Alerts aren't top-level tabs — they live in the Settings panel
// behind the gear icon (App.tsx GearButton, title is the stable selector since the
// button has no other data-* attribute).
export async function tourSettingsPanel(page: Page, speed: number, log: Logger): Promise<void> {
  const gear = page.getByTitle('Settings — Alerts & Automation')
  const visible = await gear.isVisible().catch(() => false)
  if (!visible) return

  log('  → Settings panel (Alerts & Automation, 5s)')
  await gear.click()
  await page.waitForTimeout(5000 / speed)
  // Close via Escape, not a second click on the gear — the panel is a `position:fixed;
  // top:0; right:0` sheet that, once open, sits on top of the same top-right corner the
  // gear button lives in, so a second click there hits the panel/backdrop instead and
  // Playwright (correctly) refuses to click a different element than the one it resolved.
  // Escape is the panel's own documented close path (see its "×" button's title="Close (Esc)").
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300 / speed)
}

export interface RunTourOptions {
  speed: number
  log: Logger
  /** ms to wait before the first tab switch, letting the first batch of replayed spans land. */
  initialWaitMs?: number
}

/** Runs the full tour: waits for data, walks every tab in TOUR_TABS (with the Sessions
 *  detail nav and Settings panel folded in at the right points), then returns to Sessions —
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
    // live in the Settings (gear) panel rather than a tab of their own.
    if (id === 'analytics') await tourSettingsPanel(page, speed, log)
  }

  // Return to Sessions after the tour — the most useful default landing tab.
  await page.locator('button[data-tab="sessions"]').click().catch(() => {})
}
