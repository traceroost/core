import { test, expect, type Page } from '@playwright/test'

/**
 * The Org panel (media/src/cloud/panels/OrgPanel.tsx) names TraceRoost Cloud in its header and
 * links into Cloud — the environment it talks to: stage by default in a development build, or
 * whichever endpoint the linked credential came from. Linked, Open Team View is the first row;
 * unlinked, Open TraceRoost Cloud sits under the Link callout.
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

test('unlinked: header names TraceRoost Cloud and the Cloud link sits under the Link button', async ({ page }) => {
  await openWith(page, { linked: false })
  await expect(page.getByText('TraceRoost Cloud · Not linked', { exact: true })).toBeVisible()
  const open = page.getByRole('link', { name: 'Open TraceRoost Cloud →', exact: true })
  await expect(open).toHaveAttribute('href', 'https://stage.traceroost.com')
  // Below the Link callout, not at the top of the panel.
  const [openBox, linkBox] = await Promise.all([open.boundingBox(), page.getByRole('button', { name: 'Link this machine', exact: true }).boundingBox()])
  expect(openBox!.y).toBeGreaterThan(linkBox!.y)
})

test('linked: Open Team View sits at the top, linking to its environment', async ({ page }) => {
  await openWith(page, { linked: true, indicator: 'reporting', orgId: 'o1', orgName: 'acme (personal)', role: 'admin', email: 'dev@example.com' })
  await expect(page.getByText('TraceRoost Cloud · acme (personal)', { exact: true })).toBeVisible()
  const teamView = page.getByRole('button', { name: 'Open Team View →', exact: true })
  await expect(teamView).toHaveCount(1)
  await expect(teamView).toHaveAttribute('title', 'https://stage.traceroost.com')
  // Who sees what is the role's tooltip, not a paragraph in the panel.
  const role = page.getByText('an admin', { exact: true })
  await expect(role).toHaveAttribute('title', /Admins of acme \(personal\) see org totals only/)
  await expect(page.getByText(/see org totals only/)).toHaveCount(0)
  // Above the Status section, not at the bottom of the panel.
  const [viewBox, statusBox] = await Promise.all([teamView.boundingBox(), page.getByText('Status', { exact: true }).boundingBox()])
  expect(viewBox!.y).toBeLessThan(statusBox!.y)
})

test('what is sent: short labels, with the agreed wording as each line\'s tooltip', async ({ page }) => {
  await openWith(page, { linked: false })
  const usage = page.getByText('Counts only (# of traces, tokens…)', { exact: true }).first()
  await expect(usage).toHaveAttribute('title', /^Counts only — # of traces, turns, tool calls per tool/)
  await expect(page.getByText(/tool calls per tool/)).toHaveCount(0)
})
