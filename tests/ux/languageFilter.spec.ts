import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The filter bar's Language select narrows the Traces table to traces whose primary or secondary
 * language matches; the Lang and Changes columns show the stored values ("—" when unrecorded);
 * Analytics gets a Language breakdown.
 */
const LANGS = ['python', 'typescript', 'go', undefined] as const

test('Language filter narrows traces; Lang/Changes columns and the breakdown render', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  const withLang = sessions.slice(0, 8).map((s, i) => {
    const language = LANGS[i % LANGS.length]
    return {
      ...s,
      language,
      languageSecondary: language === 'typescript' ? 'python' : language ? null : undefined,
      filesChangedCount: language ? 2 : undefined,
      linesAdded: language ? 12 : undefined,
      linesRemoved: language ? 3 : undefined,
    }
  })

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    (sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'),
    withLang,
  )
  const rows = page.locator('#sessions-content tbody tr')
  await rows.first().waitFor()
  await expect(rows).toHaveCount(8)
  await expect(page.locator('#sessions-content td.trace-language').filter({ hasText: 'Python' }).first()).toBeVisible()
  await expect(page.locator('#sessions-content td.trace-changes').filter({ hasText: '2f +12 −3' }).first()).toBeVisible()
  await expect(page.locator('#sessions-content td.trace-language').filter({ hasText: '—' })).toHaveCount(2)

  const select = page.locator('#tr-filter-language')
  // Python matches the 2 Python-primary traces and the 2 TypeScript traces with Python secondary.
  await select.selectOption('python')
  await expect(rows).toHaveCount(4)
  await select.selectOption('go')
  await expect(rows).toHaveCount(2)
  await select.selectOption('rust')
  await expect(page.locator('#sessions-content .empty-state')).toBeVisible()

  // Clear Filters resets it.
  await page.getByRole('button', { name: 'Clear Filters' }).click()
  await expect(select).toHaveValue('all')
  await expect(rows).toHaveCount(8)

  await page.locator('.tabs').getByRole('button', { name: 'Analytics', exact: true }).click()
  const breakdown = page.locator('[data-testid=language-breakdown]')
  await expect(breakdown).toBeVisible()
  await expect(breakdown).toContainText('Python')
  await expect(breakdown).toContainText('— (not recorded)')
  expect(errors, 'browser errors').toEqual([])
})
