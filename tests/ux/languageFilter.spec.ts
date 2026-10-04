import { test, expect } from '@playwright/test'
import { sessions } from './fixtures'

/**
 * The filter bar's Language select narrows the Traces table to traces whose primary or secondary
 * language matches; the Lang column shows the abbreviation (full name on hover), Lang and Changes
 * show "—" when unrecorded;
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
  // Compact cells show the short form (LANGUAGE_ABBREVIATIONS); the full name is in the title and
  // aria-label, and the "+1" badge's title names both full languages.
  const langCells = page.locator('#sessions-content td.trace-language')
  const py = langCells.filter({ hasText: /^Py$/ }).first()
  await expect(py).toBeVisible()
  await expect(py).toHaveAttribute('title', 'Language: Python')
  await expect(py).toHaveAttribute('aria-label', 'Language: Python')
  const ts = langCells.filter({ hasText: /^TS\+1$/ }).first()
  await expect(ts).toBeVisible()
  await expect(ts).toHaveAttribute('title', 'Primary: TypeScript · Secondary: Python')
  await expect(ts).toHaveAttribute('aria-label', 'Language: TypeScript + Python')
  await expect(ts.locator('.trace-language-secondary')).toHaveAttribute('title', 'Primary: TypeScript · Secondary: Python')
  await expect(langCells.filter({ hasText: /^Go$/ })).toHaveCount(2)
  await expect(langCells.filter({ hasText: /TypeScript|Python/ })).toHaveCount(0)
  await expect(page.locator('#sessions-content td.trace-changes').filter({ hasText: '2f +12 −3' }).first()).toBeVisible()
  const unrecorded = langCells.filter({ hasText: /^—$/ })
  await expect(unrecorded).toHaveCount(2)
  await expect(unrecorded.first()).toHaveAttribute('aria-label', 'Language: not recorded')

  const select = page.locator('#tr-filter-language')
  // Only languages some trace has are offered, in allowlist order — full names, not abbreviations.
  await expect(select.locator('option')).toHaveText(['All', 'TypeScript', 'Python', 'Go'])
  // Python matches the 2 Python-primary traces and the 2 TypeScript traces with Python secondary.
  await select.selectOption('python')
  await expect(rows).toHaveCount(4)
  await select.selectOption('go')
  await expect(rows).toHaveCount(2)
  await expect(select.locator('option[value=rust]')).toHaveCount(0)

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

test('Shell, SQL, HTML, CSS and Dart get their own abbreviations and filter options', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const NEW = [['css', 'CSS'], ['shell', 'Sh'], ['dart', 'Dart'], ['sql', 'SQL'], ['html', 'HTML']] as const
  const withLang = sessions.slice(0, NEW.length).map((s, i) => ({ ...s, language: NEW[i][0], languageSecondary: null }))

  await page.goto('/')
  await page.locator('#sessions-content').waitFor()
  await page.evaluate(
    (sessions) => window.postMessage({ type: 'update', sessionSummary: { sessions } }, '*'),
    withLang,
  )
  const rows = page.locator('#sessions-content tbody tr')
  await expect(rows).toHaveCount(NEW.length)
  const langCells = page.locator('#sessions-content td.trace-language')
  await expect(langCells.filter({ hasText: /^Sh$/ })).toHaveAttribute('title', 'Language: Shell')
  for (const [, abbr] of NEW) await expect(langCells.filter({ hasText: new RegExp(`^${abbr}$`) })).toHaveCount(1)

  // Allowlist order, full names.
  const select = page.locator('#tr-filter-language')
  await expect(select.locator('option')).toHaveText(['All', 'Dart', 'Shell', 'SQL', 'HTML', 'CSS'])
  await select.selectOption('sql')
  await expect(rows).toHaveCount(1)
  expect(errors, 'browser errors').toEqual([])
})
