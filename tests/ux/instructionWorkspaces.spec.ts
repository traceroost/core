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
        { agent: 'claude_code', agents: ['claude_code'], label: 'Claude Code', relativePath: 'CLAUDE.md', exists: false, content: '' },
        { agent: 'copilot', agents: ['copilot'], label: 'GitHub Copilot', relativePath: '.github/copilot-instructions.md', exists: false, content: '' },
        { agent: 'codex', agents: ['codex', 'opencode', 'cursor'], label: 'Codex · OpenCode', relativePath: 'AGENTS.md', exists: true, content: '# Rules' },
        { agent: 'cursor', agents: ['cursor'], label: 'Cursor', relativePath: '.cursor/rules/traceroost.mdc', exists: false, content: '' },
      ],
    }, '*')
    window.postMessage({ type: 'instructionFiles', workspace: cloud, files: [], missing: true }, '*')
  }, { core: CORE, cloud: CLOUD })

  const coreGroup = page.locator(`[data-instructions-workspace="${CORE}"]`)
  const cloudGroup = page.locator(`[data-instructions-workspace="${CLOUD}"]`)
  await expect(coreGroup).toContainText('Repo:')
  await expect(cloudGroup).toContainText('Repo:')
  // Only the files read by agents in core's traces (Copilot, Codex): no CLAUDE.md or Cursor rule.
  const coreFiles = coreGroup.locator('[data-instruction-file-status]')
  await expect(coreFiles).toHaveText([
    '.github/copilot-instructions.md · not found',
    'AGENTS.md · present',
  ])
  await expect(coreGroup).toContainText(CORE)
  await expect(cloudGroup).toContainText(CLOUD)

  const title = 'Add hotModule.ts to instruction file'
  const coreCard = coreGroup.locator('[data-suggestion-id]').filter({ hasText: title })
  const cloudCard = cloudGroup.locator('[data-suggestion-id]').filter({ hasText: title })
  await expect(coreCard).toHaveCount(1)
  await expect(cloudCard).toHaveCount(1)

  // Agent chips are based on the traces that triggered this repo's card, not every supported agent.
  await expect(coreCard.locator('[data-observed-agent]')).toHaveText(['Copilot', 'Codex'])
  await expect(cloudCard.locator('[data-observed-agent]')).toHaveText(['Claude', 'OpenCode'])
  await expect(coreCard).toContainText('Observed in traces:')

  // The missing folder: a note, and no picker or Apply.
  await expect(cloudGroup).toContainText('no longer exists on this machine')
  await expect(cloudCard.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)

  // The core card applies into core. Like the status bar, the picker offers only the files its
  // agents read: the (create) Copilot file, not CLAUDE.md or the Cursor rule.
  const picker = coreCard.getByLabel('Instruction file to apply to')
  await expect(picker).toHaveValue('AGENTS.md')
  await expect(picker.locator('option')).toHaveText(['.github/copilot-instructions.md (create)', 'AGENTS.md'])
  await picker.selectOption('.github/copilot-instructions.md')
  await coreCard.getByRole('button', { name: 'Apply', exact: true }).click()
  const msg = (await posted()).find((m) => m.type === 'applyInstructionSuggestion')
  expect(msg).toMatchObject({ workspace: CORE, targetFile: '.github/copilot-instructions.md', title })

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

test('each repo group collapses from its header, and the choice survives a reload', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const repoSessions = sessions.map((s) => ({ ...s, filesRead: ['src/hotModule.ts'] }))
  const open = async () => {
    await page.locator('#sessions-content').waitFor()
    await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), repoSessions)
    await page.locator('.tabs').getByRole('button', { name: 'Advisor', exact: true }).click()
  }
  await page.goto('/')
  await open()

  const coreGroup = page.locator(`[data-instructions-workspace="${CORE}"]`)
  const cloudGroup = page.locator(`[data-instructions-workspace="${CLOUD}"]`)
  const coreHeader = coreGroup.getByRole('button', { expanded: true }).first()
  await expect(coreHeader).toContainText('Repo:')
  const coreCards = coreGroup.locator('[data-suggestion-id]')
  await expect(coreCards.first()).toBeVisible()
  const coreCount = await coreCards.count()
  const cloudCount = await cloudGroup.locator('[data-suggestion-id]').count()
  await expect(coreGroup.locator('[data-repo-metric=pending]')).toHaveText(`${coreCount} pending`)
  await expect(page.getByText('2 repos')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('instructions-expanded.png') })

  // Collapsing core hides its cards; cloud's stay.
  await coreHeader.click()
  const coreToggle = coreGroup.locator('button[aria-controls]')
  await expect(coreToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(coreCards).toHaveCount(0)
  await expect(cloudGroup.locator('[data-suggestion-id]')).toHaveCount(cloudCount)
  // The header still says what's inside.
  await expect(coreGroup.locator('[data-repo-metric=pending]')).toHaveText(`${coreCount} pending`)

  // Remembered across a reload.
  await page.reload()
  await open()
  await expect(coreToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(cloudGroup.locator('[data-suggestion-id]')).toHaveCount(cloudCount)

  await page.getByRole('button', { name: 'Collapse all' }).click()
  await expect(page.locator('[data-suggestion-id]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Collapse all' })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('instructions-collapsed.png') })
  await page.getByRole('button', { name: 'Expand all' }).click()
  await expect(page.locator('[data-suggestion-id]')).toHaveCount(coreCount + cloudCount)

  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'document overflow').toBe(false)
  expect(errors, 'browser errors').toEqual([])
})

test('repo order is shown on each header and can be changed; header filters are called out', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const DAY = 86_400_000
  const hot = { filesRead: ['src/hotModule.ts'] }
  // core: most traces (32). cloud: fewer (10) but the most recent. No repo: the most of all (40),
  // yet always last.
  const repoSessions = [
    ...sessions.filter((_, i) => i % 2 === 0).map((s) => ({ ...s, ...hot, startTime: new Date(Date.parse(s.startTime) - DAY).toISOString() })),
    ...sessions.filter((_, i) => i % 2 === 1).slice(0, 10).map((s) => ({ ...s, ...hot })),
    ...sessions.slice(0, 40).map((s) => ({ ...s, ...hot, sessionId: `none-${s.sessionId}`, workspace: undefined, startTime: new Date(Date.parse(s.startTime) - 10 * DAY).toISOString() })),
  ]
  const open = async () => {
    await page.locator('#sessions-content').waitFor()
    await page.evaluate((sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'), repoSessions)
    await page.locator('.tabs').getByRole('button', { name: 'Advisor', exact: true }).click()
  }
  await page.goto('/')
  await open()

  const order = () => page.locator('[data-instructions-workspace]').evaluateAll((els) => els.map((el) => el.getAttribute('data-instructions-workspace')))
  const sortBy = page.getByLabel('Sort by')
  await expect(sortBy).toHaveValue('traces')
  await expect.poll(order).toEqual([CORE, CLOUD, ''])
  const core = page.locator(`[data-instructions-workspace="${CORE}"]`)
  await expect(core.locator('[data-repo-metric=traces]')).toHaveText('32 traces')
  await expect(core.locator('[data-sorted]')).toHaveAttribute('data-repo-metric', 'traces')
  await expect(page.locator('[data-instructions-filter-notice]')).toHaveCount(0)

  await sortBy.selectOption('recent')
  await expect.poll(order).toEqual([CLOUD, CORE, ''])
  await expect(core.locator('[data-sorted]')).toHaveAttribute('data-repo-metric', 'recent')
  await page.screenshot({ path: testInfo.outputPath('instructions-sorted-recent.png') })

  // The choice survives a reload.
  await page.reload()
  await open()
  await expect(sortBy).toHaveValue('recent')
  await expect.poll(order).toEqual([CLOUD, CORE, ''])

  // A header filter is called out, and clearing it from here restores every repo.
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  const notice = page.locator('[data-instructions-filter-notice]')
  await expect(notice).toContainText('Filtered: Agent: Codex')
  await expect(notice).toContainText('repo order below use only the')
  await expect(page.locator(`[data-instructions-workspace="${CLOUD}"]`)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('instructions-filtered.png') })
  await notice.getByRole('button', { name: 'Clear filters' }).click()
  await expect(notice).toHaveCount(0)
  await expect.poll(order).toEqual([CLOUD, CORE, ''])

  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'document overflow').toBe(false)
  expect(errors, 'browser errors').toEqual([])
})
