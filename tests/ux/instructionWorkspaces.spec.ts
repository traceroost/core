import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * Advisor → Instructions File in the standalone dashboard (no open folder): suggestions are grouped
 * per repo, each group asks the host for its own instruction files and applied/dismissed state, and
 * Apply / Dismiss name that group's workspace. A repo whose folder the host reports missing keeps its
 * suggestions but loses Apply. The fixture host (serve.ts) sets __STANDALONE__ and records every
 * posted message in window.__posted.
 */
const CORE = '/fixtures/core'
const CLOUD = '/fixtures/cloud'

test('suggestions are grouped by repo and act on their own workspace', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Both repos' traces touch the same file, so both get a hot-file card with the same id.
  const repoSessions = sessions.map((s) => ({ ...s, filesRead: ['src/hotModule.ts'] }))
  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    (sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'),
    repoSessions,
  )
  await page.locator('.tabs').getByRole('button', { name: 'Advisor', exact: true }).click()

  const posted = () => page.evaluate(() => (window as any).__posted as Array<Record<string, unknown>>)
  for (const ws of [CORE, CLOUD]) {
    for (const type of ['getInstructionFiles', 'getAppliedSuggestions', 'getDismissedSuggestions']) {
      await expect.poll(async () => (await posted()).some((m) => m.type === type && m.workspace === ws), `${type} ${ws}`).toBe(true)
    }
  }
  await page.evaluate(({ core, cloud }) => {
    window.postMessage({
      type: 'instructionFiles', workspace: core,
      files: [
        { agent: 'claude_code', label: 'Claude Code', relativePath: 'CLAUDE.md', exists: false, content: '' },
        { agent: 'codex', label: 'Codex · OpenCode', relativePath: 'AGENTS.md', exists: true, content: '# Rules' },
        { agent: 'cursor', label: 'Cursor', relativePath: '.cursor/rules/traceroost.mdc', exists: false, content: '' },
      ],
    }, '*')
    window.postMessage({ type: 'instructionFiles', workspace: cloud, files: [], missing: true }, '*')
  }, { core: CORE, cloud: CLOUD })

  const coreGroup = page.locator(`[data-instructions-workspace="${CORE}"]`)
  const cloudGroup = page.locator(`[data-instructions-workspace="${CLOUD}"]`)
  await expect(coreGroup).toContainText(CORE)
  await expect(cloudGroup).toContainText(CLOUD)

  const title = 'Add hotModule.ts to instruction file'
  const coreCard = coreGroup.locator('[data-suggestion-id]').filter({ hasText: title })
  const cloudCard = cloudGroup.locator('[data-suggestion-id]').filter({ hasText: title })
  await expect(coreCard).toHaveCount(1)
  await expect(cloudCard).toHaveCount(1)

  // Cursor and OpenCode are among the agents a hot-file card targets.
  await expect(coreCard).toContainText('OpenCode')
  await expect(coreCard).toContainText('Cursor')

  // The missing folder: a note, and no picker or Apply.
  await expect(cloudGroup).toContainText('no longer exists on this machine')
  await expect(cloudCard.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)

  // The core card applies into core, with the (create) Cursor rule as one option.
  const picker = coreCard.getByLabel('Instruction file to apply to')
  await expect(picker).toHaveValue('AGENTS.md')
  await expect(picker.locator('option')).toHaveText(['CLAUDE.md (create)', 'AGENTS.md', '.cursor/rules/traceroost.mdc (create)'])
  await picker.selectOption('.cursor/rules/traceroost.mdc')
  await coreCard.getByRole('button', { name: 'Apply', exact: true }).click()
  const msg = (await posted()).find((m) => m.type === 'applyInstructionSuggestion')
  expect(msg).toMatchObject({ workspace: CORE, targetFile: '.cursor/rules/traceroost.mdc', title })

  // The host's reply for core hides core's card only — cloud's card with the same id stays.
  await page.evaluate((m) => window.postMessage({
    type: 'appliedSuggestions', workspace: m.workspace,
    records: [{
      id: m.id, workspace: m.workspace, category: m.category, title: m.title, suggestedText: m.suggestedText,
      appliedTo: m.targetFile, appliedText: m.appliedText, appliedAt: new Date().toISOString(),
      appliedAtMs: Date.now(), baselineCostAvg: 0, baselineTurnsAvg: 0, baselineInsufficient: true,
    }],
  }, '*'), msg as Record<string, unknown>)
  await expect(coreCard).toHaveCount(0)
  await expect(coreGroup.getByTitle('Remove from instruction file and move back to pending')).toHaveCount(1)
  await expect(cloudCard).toHaveCount(1)

  // Dismiss names cloud's workspace and leaves core's applied record alone.
  await cloudCard.getByTitle('Dismiss').click()
  await expect(cloudCard).toHaveCount(0)
  expect((await posted()).find((m) => m.type === 'dismissInstructionSuggestion')).toMatchObject({ workspace: CLOUD, id: msg?.id })
  await expect(coreGroup.getByTitle('Remove from instruction file and move back to pending')).toHaveCount(1)

  // Remove names core's workspace.
  await coreGroup.getByTitle('Remove from instruction file and move back to pending').click()
  expect((await posted()).find((m) => m.type === 'removeInstructionSuggestion')).toMatchObject({ workspace: CORE, id: msg?.id })

  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'document overflow').toBe(false)
  expect(errors, 'browser errors').toEqual([])
})
