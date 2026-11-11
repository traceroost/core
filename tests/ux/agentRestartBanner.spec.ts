import { test, expect, type Page } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * "Restart your agents" (AgentRestartBanner in media/src/App.tsx). After agent setup changes an
 * agent's settings, the host lists the agents that still have to be restarted
 * (src/agentRestart.ts) and drops each one when its traces arrive; the banner shows the rest and
 * can be dismissed, which tells the host.
 */

type Posted = Array<{ type: string }>

async function load(page: Page) {
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate((s) => window.postMessage({ type: 'update', sessionSummary: { sessions: s } }, '*'), sessions.slice(0, 4))
}

const post = (page: Page, agentRestart: unknown) =>
  page.evaluate((a) => window.postMessage({ type: 'update', agentRestart: a }, '*'), agentRestart)

test('lists each agent to restart, clears lines as the host hears from them, and dismiss tells the server', async ({ page }) => {
  const actions: string[] = []
  await page.route('**/action', async route => {
    actions.push(route.request().postData() ?? '')
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await load(page)
  const banner = page.locator('.agent-restart-banner')
  await expect(banner).toHaveCount(0)

  await post(page, { port: 4319, agents: ['claudeCode', 'codex', 'copilot'] })
  await expect(banner).toContainText('Restart your agents to start tracing.')
  await expect(banner).toContainText('port 4319')
  await expect(banner.locator('li')).toHaveCount(3)
  await expect(banner).toContainText('claude --continue')
  await expect(banner).toContainText('codex resume --last')
  // The background service can't reload an editor window: it says how, with no button.
  await expect(banner).toContainText('Developer: Reload Window')
  await expect(banner.getByRole('button', { name: 'Reload VS Code' })).toHaveCount(0)
  expect(await banner.innerText()).not.toContain('—')

  // Codex's traces arrived: only its line goes.
  await post(page, { port: 4319, agents: ['claudeCode', 'copilot'] })
  await expect(banner.locator('li')).toHaveCount(2)
  await expect(banner).not.toContainText('codex resume')

  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => actions).toEqual([JSON.stringify({ type: 'dismissAgentRestart' })])
})

test('the banner goes on its own once every agent has been heard from', async ({ page }) => {
  await load(page)
  await post(page, { port: 4318, agents: ['claudeCode'] })
  await expect(page.locator('.agent-restart-banner li')).toHaveCount(1)
  await post(page, null)
  await expect(page.locator('.agent-restart-banner')).toHaveCount(0)
})

test('in VS Code, Copilot gets a Reload VS Code button and both actions go to the extension', async ({ page }) => {
  // The fixture page sets __STANDALONE__ = true; pin it false so the page renders as the webview.
  await page.addInitScript(() => Object.defineProperty(window, '__STANDALONE__', { value: false, writable: false }))
  await load(page)
  await post(page, { port: 4318, agents: ['copilot'] })
  const banner = page.locator('.agent-restart-banner')
  await banner.getByRole('button', { name: 'Reload VS Code' }).click()
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  await expect(banner).toHaveCount(0)
  const posted = await page.evaluate(() => (window as unknown as { __posted: Posted }).__posted.map(m => m.type))
  expect(posted.filter(t => t === 'reloadWindow' || t === 'dismissAgentRestart')).toEqual(['reloadWindow', 'dismissAgentRestart'])
})
