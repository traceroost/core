import { test, expect, type Page } from '@playwright/test'

/**
 * The Org panel (media/src/cloud/panels/OrgPanel.tsx) names TraceRoost Cloud in its header, and
 * its first row is the link into Cloud — the environment it talks to: stage by default in a
 * development build, or whichever endpoint the linked credential came from.
 */
const BASE = {
  clientVersion: '0.0.0', indicator: 'unlinked', environment: 'stage', environmentSource: 'default',
  environmentEditable: true, cloudRateOverrides: {}, sending: false, endpoint: 'https://stage.traceroost.com',
}

async function openWith(page: Page, status: Record<string, unknown>) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.getByRole('button', { name: 'TraceRoost Cloud org', exact: true }).click()
  await page.evaluate(s => window.postMessage({ type: 'orgStatus', status: s }, '*'), { ...BASE, ...status })
}

test('unlinked: header names TraceRoost Cloud and the first row links to the default environment', async ({ page }) => {
  await openWith(page, { linked: false })
  await expect(page.getByText('TraceRoost Cloud · Not linked', { exact: true })).toBeVisible()
  const open = page.getByRole('link', { name: 'Open TraceRoost Cloud →', exact: true })
  await expect(open).toHaveAttribute('href', 'https://stage.traceroost.com')
})

test('linked: Open Team View sits at the top, linking to its environment', async ({ page }) => {
  await openWith(page, { linked: true, indicator: 'reporting', orgId: 'o1', orgName: 'rogerjreed (personal)', role: 'admin', email: 'dev@example.com' })
  await expect(page.getByText('TraceRoost Cloud · rogerjreed (personal)', { exact: true })).toBeVisible()
  const teamView = page.getByRole('button', { name: 'Open Team View →', exact: true })
  await expect(teamView).toHaveCount(1)
  await expect(teamView).toHaveAttribute('title', 'https://stage.traceroost.com')
  // Who sees what is the role's tooltip, not a paragraph in the panel.
  const role = page.getByText('an admin', { exact: true })
  await expect(role).toHaveAttribute('title', /Admins of rogerjreed \(personal\) see org totals only/)
  await expect(page.getByText(/see org totals only/)).toHaveCount(0)
  // Above the Status section, not at the bottom of the panel.
  const [viewBox, statusBox] = await Promise.all([teamView.boundingBox(), page.getByText('Status', { exact: true }).boundingBox()])
  expect(viewBox!.y).toBeLessThan(statusBox!.y)
})

test('what is sent: short labels, with the agreed wording as each line\'s tooltip', async ({ page }) => {
  await openWith(page, { linked: false })
  const usage = page.getByText('Usage counts', { exact: true }).first()
  await expect(usage).toHaveAttribute('title', /^Usage counts — traces, turns, tool calls by tool name/)
  await expect(page.getByText(/tool calls by tool name/)).toHaveCount(0)
})
