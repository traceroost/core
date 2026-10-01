import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Advisor → Instructions File: a suggestion card's Apply posts applyInstructionSuggestion with the
 * picked target file, stays disabled while in flight, and the card leaves Pending once the host
 * replies with the applied record (what dashboardPanel.ts and the standalone polyfill both send).
 * The fixture host (serve.ts) records every posted message in window.__posted.
 */
const WS = '/fixtures/core'

test('Apply posts the suggestion with its target file and waits for the host', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Every trace in this repo touches the same file, so the hot-file rule fires.
  const repoSessions = sessions.map((s) => ({ ...s, workspace: WS, filesRead: ['src/hotModule.ts'] }))
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    ({ sessions, ws }) => window.postMessage({ type: 'update', sessionSummary: { sessions }, currentWorkspace: ws }, '*'),
    { sessions: repoSessions, ws: WS },
  )
  await page.locator('.tabs').getByRole('button', { name: 'Advisor', exact: true }).click()

  const posted = () => page.evaluate(() => (window as any).__posted as Array<Record<string, unknown>>)
  await expect.poll(async () => (await posted()).some((m) => m.type === 'getInstructionFiles' && m.workspace === WS)).toBe(true)
  await page.evaluate(() => window.postMessage({
    type: 'instructionFiles',
    files: [
      { agent: 'claude_code', label: 'Claude Code', relativePath: 'CLAUDE.md', exists: false, content: '' },
      { agent: 'codex', label: 'Codex', relativePath: 'AGENTS.md', exists: true, content: '# Rules' },
    ],
  }, '*'))

  const card = page.locator('[data-suggestion-id]').filter({ hasText: 'Add hotModule.ts to instruction file' }).first()
  const picker = card.getByLabel('Instruction file to apply to')
  await expect(picker).toHaveValue('AGENTS.md') // an existing file is the default
  await picker.selectOption('CLAUDE.md')
  const apply = card.getByRole('button', { name: 'Apply', exact: true })
  await apply.click()

  await expect(card.getByRole('button', { name: 'Applying…' })).toBeDisabled()
  const msg = (await posted()).find((m) => m.type === 'applyInstructionSuggestion')
  expect(msg).toMatchObject({
    workspace: WS, targetFile: 'CLAUDE.md', category: 'context', title: 'Add hotModule.ts to instruction file',
  })
  expect(typeof msg?.id).toBe('string')
  expect(msg?.appliedText).toBe(msg?.suggestedText)
  expect(String(msg?.appliedText)).toContain('src/hotModule.ts')

  // The host's reply moves it from Pending to Applied.
  await page.evaluate((m) => window.postMessage({
    type: 'appliedSuggestions',
    records: [{
      id: m.id, workspace: m.workspace, category: m.category, title: m.title, suggestedText: m.suggestedText,
      appliedTo: m.targetFile, appliedText: m.appliedText, appliedAt: new Date().toISOString(),
      appliedAtMs: Date.now(), baselineCostAvg: 0, baselineTurnsAvg: 0, baselineInsufficient: true,
    }],
  }, '*'), msg as Record<string, unknown>)
  await expect(page.locator(`[data-suggestion-id="${msg?.id}"]`)).toHaveCount(0)
  await expect(page.getByTitle('Remove from instruction file and move back to pending')).toHaveCount(1)

  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'document overflow').toBe(false)
  expect(errors, 'browser errors').toEqual([])
})
