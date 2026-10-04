import { test, expect } from '@playwright/test'

/**
 * The header's icon-only buttons (App.tsx) draw just an SVG — each needs an accessible name of
 * its own, or a screen reader announces a row of unlabeled "button"s.
 */
test('header icon buttons have accessible names', async ({ page }) => {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  for (const name of ['Alerts', 'Action log', 'Settings', 'Pricing', 'Help']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(1)
  }
  const help = page.getByRole('button', { name: 'Help', exact: true })
  await expect(help).toHaveAttribute('aria-pressed', 'false')
  await help.click()
  await expect(help).toHaveAttribute('aria-pressed', 'true')
})

/**
 * "Make a suggestion" (App.tsx's SuggestButton, URL from media/src/suggest.ts) sits in the same
 * icon group and opens TraceRoost Cloud's public /suggest page in a new browser tab — carrying
 * only from=core and a "core <version> · <tab>" context, never workspace paths or prompts.
 */
test('suggestion link opens the public /suggest page with a context free of user data', async ({ page, context }) => {
  await context.route('https://stage.traceroost.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>suggest</title>' }))
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  const suggest = page.getByRole('link', { name: 'Make a suggestion', exact: true })
  await expect(suggest).toHaveCount(1)
  // Same icon group as Help: both are children of the right-hand header container.
  const group = page.locator('.tabs > div').filter({ has: page.getByRole('button', { name: 'Help', exact: true }) })
  await expect(group.getByRole('link', { name: 'Make a suggestion', exact: true })).toHaveCount(1)
  await expect(suggest).toHaveAttribute('target', '_blank')

  const [popup] = await Promise.all([page.waitForEvent('popup'), suggest.click()])
  const url = new URL(popup.url())
  expect(`${url.origin}${url.pathname}`).toBe('https://stage.traceroost.com/suggest')
  expect([...url.searchParams.keys()]).toEqual(['from', 'context'])
  expect(url.searchParams.get('from')).toBe('core')
  expect(url.searchParams.get('context')).toBe('core UX fixture · Traces')

  // The context follows the active tab, and still carries nothing from the fixture traces.
  await page.getByRole('button', { name: 'Help', exact: true }).click()
  const href = new URL((await suggest.getAttribute('href'))!)
  expect(href.searchParams.get('context')).toBe('core UX fixture · Help')
  expect(href.search).not.toMatch(/fixtures|Task|ux-/)
})
