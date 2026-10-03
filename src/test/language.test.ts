import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  deriveSessionLanguage, languageForPath, languageFromRecord, languageLabel, isSessionLanguage,
  LANGUAGE_IDS, EXTENSION_LANGUAGE, OTHER_CODE_EXTENSIONS,
} from '../language'
import { WIRE_LANGUAGES } from '../cloud/forward/schema'

suite('language — per-session programming language', () => {
  test('src/language.ts and media/src/language.ts are byte-identical', () => {
    const root = path.resolve(__dirname, '../../..')
    assert.strictEqual(
      fs.readFileSync(path.join(root, 'media/src/language.ts'), 'utf8'),
      fs.readFileSync(path.join(root, 'src/language.ts'), 'utf8'),
    )
  })

  test('the allowlist is the wire enum, and the committed schema lists the same ids', () => {
    assert.deepStrictEqual([...LANGUAGE_IDS], [...WIRE_LANGUAGES])
    const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'schema', 'rollup.v1.json'), 'utf-8'))
    assert.deepStrictEqual(schema.$defs.language.enum, [...LANGUAGE_IDS])
    assert.deepStrictEqual(schema.$defs.session.properties.language_secondary.enum, [...LANGUAGE_IDS.filter(l => l !== 'none'), null])
  })

  test('the extension map covers the spec extension sets exactly', () => {
    const byLang = (lang: string) => Object.entries(EXTENSION_LANGUAGE).filter(([, l]) => l === lang).map(([e]) => e).sort()
    assert.deepStrictEqual(byLang('typescript'), ['.cts', '.mts', '.ts', '.tsx'])
    assert.deepStrictEqual(byLang('javascript'), ['.cjs', '.js', '.jsx', '.mjs'])
    assert.deepStrictEqual(byLang('python'), ['.py', '.pyi'])
    assert.deepStrictEqual(byLang('cpp'), ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'])
    assert.deepStrictEqual(byLang('kotlin'), ['.kt', '.kts'])
    for (const ext of OTHER_CODE_EXTENSIONS) assert.strictEqual(EXTENSION_LANGUAGE[ext], undefined, ext)
  })

  test('a mixed session: most distinct files wins, runner-up is secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({
      filesRead: ['/r/a.py', '/r/b.py', '/r/c.py', '/r/web/app.ts'],
      filesChanged: ['/r/web/app.ts', '/r/web/util.ts', '/r/run.sh'],
    }), { language: 'python', languageSecondary: 'typescript' })
  })

  test('a README/config-only session is none, with no secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({
      filesRead: ['/r/README.md', '/r/package.json', '/r/.env', '/r/config.yaml', '/r/settings.ini', '/r/pom.xml', '/r/logo.png', '/r/data.csv', '/r/notes.txt'],
      filesChanged: ['/r/CHANGELOG.md', '/r/tsconfig.json', '/r/Cargo.toml', '/r/.eslintrc.js'],
    }), { language: 'none', languageSecondary: null })
  })

  test('lockfiles are ignored', () => {
    for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'poetry.lock', 'composer.lock']) {
      assert.strictEqual(languageForPath(`/r/${f}`), null, f)
    }
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/Cargo.lock', '/r/src/main.rs'] }), { language: 'rust', languageSecondary: null })
  })

  test('one language gives a null secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/a.go', '/r/b.go'], filesRead: ['/r/go.mod', '/r/README.md'] }),
      { language: 'go', languageSecondary: null })
  })

  test('ties break by changed-over-read, then allowlist order', () => {
    // 1 file each; Python was changed, TypeScript only read → python first.
    assert.deepStrictEqual(deriveSessionLanguage({ filesRead: ['/r/a.ts'], filesChanged: ['/r/b.py'] }),
      { language: 'python', languageSecondary: 'typescript' })
    // Same count, same changed count → allowlist order (typescript before python).
    assert.deepStrictEqual(deriveSessionLanguage({ filesRead: ['/r/b.py', '/r/a.ts'] }),
      { language: 'typescript', languageSecondary: 'python' })
    // Count beats changed: 2 read Java files over 1 changed Ruby file.
    assert.deepStrictEqual(deriveSessionLanguage({ filesRead: ['/r/A.java', '/r/B.java'], filesChanged: ['/r/x.rb'] }),
      { language: 'java', languageSecondary: 'ruby' })
  })

  test('Windows paths: backslashes, drive letters and case-insensitive dedup', () => {
    assert.strictEqual(languageForPath('C:\\work\\app\\src\\Program.cs'), 'csharp')
    assert.strictEqual(languageForPath('C:\\work\\app\\.env.local'), null)
    assert.deepStrictEqual(deriveSessionLanguage({
      filesRead: ['C:\\work\\a.cs', 'c:/WORK/A.CS', 'C:\\work\\b.cs', 'C:\\work\\x.kt'],
      filesChanged: ['C:\\work\\y.kt', 'C:\\WORK\\B.cs'],
    }), { language: 'csharp', languageSecondary: 'kotlin' })
  })

  test('extensions match case-insensitively', () => {
    assert.strictEqual(languageForPath('/r/Main.JAVA'), 'java')
    assert.strictEqual(languageForPath('/r/view.TSX'), 'typescript')
    assert.strictEqual(languageForPath('/r/lib.Hpp'), 'cpp')
    assert.strictEqual(languageForPath('/r/script.PS1'), 'other')
  })

  test('a file read 50 times counts once', () => {
    const reads = Array.from({ length: 50 }, () => '/r/huge.py')
    assert.deepStrictEqual(deriveSessionLanguage({ filesRead: reads, filesChanged: ['/r/a.ts', '/r/b.ts'] }),
      { language: 'typescript', languageSecondary: 'python' })
  })

  test('other code is counted as other (and may be secondary); unknown extensions are excluded', () => {
    assert.strictEqual(languageForPath('/r/q.sql'), 'other')
    assert.strictEqual(languageForPath('/r/App.vue'), 'other')
    assert.strictEqual(languageForPath('/r/blob.weird'), null)
    assert.strictEqual(languageForPath('/r/Makefile'), null)
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/a.ts', '/r/b.ts', '/r/deploy.sh', '/r/x.weird'] }),
      { language: 'typescript', languageSecondary: 'other' })
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/a.sh', '/r/b.sql'] }),
      { language: 'other', languageSecondary: null })
  })

  test('languageFromRecord keeps valid ids, re-derives otherwise, never passes free text', () => {
    assert.deepStrictEqual(languageFromRecord({ language: 'rust', languageSecondary: 'python' }, {}), { language: 'rust', languageSecondary: 'python' })
    assert.deepStrictEqual(languageFromRecord({ language: 'rust', languageSecondary: 'none' }, {}), { language: 'rust', languageSecondary: null })
    assert.deepStrictEqual(languageFromRecord({ language: 'Brainfuck' }, { filesChanged: ['/r/a.rb'] }), { language: 'ruby', languageSecondary: null })
    assert.strictEqual(isSessionLanguage('Brainfuck'), false)
    assert.strictEqual(languageLabel(undefined), '—')
    assert.strictEqual(languageLabel('cpp'), 'C/C++')
  })
})
