import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import {
  deriveSessionLanguage, languageForPath, languageFromRecord, languageLabel, isSessionLanguage,
  LANGUAGE_IDS, EXTENSION_LANGUAGE, OTHER_CODE_EXTENSIONS, COMPONENT_EXTENSIONS, LANGUAGE_ABBREVIATIONS,
  LANGUAGE_LABELS, languageAbbreviation,
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
    assert.deepStrictEqual(schema.$defs.session.properties.language_secondary.enum, [...LANGUAGE_IDS.filter(l => l !== 'none' && l !== 'no_files'), null])
  })

  test('the extension map covers the spec extension sets exactly', () => {
    const byLang = (lang: string) => Object.entries(EXTENSION_LANGUAGE).filter(([, l]) => l === lang).map(([e]) => e).sort()
    assert.deepStrictEqual(byLang('typescript'), ['.cts', '.mts', '.ts', '.tsx'])
    assert.deepStrictEqual(byLang('javascript'), ['.cjs', '.js', '.jsx', '.mjs'])
    assert.deepStrictEqual(byLang('python'), ['.py', '.pyi'])
    assert.deepStrictEqual(byLang('cpp'), ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'])
    assert.deepStrictEqual(byLang('kotlin'), ['.kt', '.kts'])
    assert.deepStrictEqual(byLang('dart'), ['.dart'])
    assert.deepStrictEqual(byLang('shell'), ['.bash', '.fish', '.sh', '.zsh'])
    assert.deepStrictEqual(byLang('sql'), ['.sql'])
    assert.deepStrictEqual(byLang('html'), ['.htm', '.html'])
    assert.deepStrictEqual(byLang('css'), ['.css', '.less', '.sass', '.scss'])
    for (const ext of [...OTHER_CODE_EXTENSIONS, ...COMPONENT_EXTENSIONS]) assert.strictEqual(EXTENSION_LANGUAGE[ext], undefined, ext)
    for (const ext of COMPONENT_EXTENSIONS) assert.ok(!OTHER_CODE_EXTENSIONS.includes(ext), ext)
  })

  test('Shell, SQL, HTML, CSS and Dart are languages of their own; PowerShell stays other', () => {
    const cases: [string, string][] = [
      ['/r/deploy.sh', 'shell'], ['/r/setup.BASH', 'shell'], ['/r/prompt.zsh', 'shell'], ['/r/conf.fish', 'shell'],
      ['/r/db/001_init.sql', 'sql'],
      ['/r/index.html', 'html'], ['/r/legacy.HTM', 'html'],
      ['/r/site.css', 'css'], ['/r/app.scss', 'css'], ['/r/old.sass', 'css'], ['/r/theme.less', 'css'],
      ['/r/lib/main.dart', 'dart'],
      ['/r/build.ps1', 'other'],
    ]
    for (const [p, lang] of cases) assert.strictEqual(languageForPath(p), lang, p)
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/a.sql', '/r/b.sql', '/r/run.sh'] }),
      { language: 'sql', languageSecondary: 'shell' })
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/index.html', '/r/site.css', '/r/app.scss'] }),
      { language: 'css', languageSecondary: 'html' })
  })

  test('labels and abbreviations cover every id, and new ids read as standard short forms', () => {
    assert.deepStrictEqual(Object.keys(LANGUAGE_LABELS), [...LANGUAGE_IDS])
    assert.deepStrictEqual(Object.keys(LANGUAGE_ABBREVIATIONS), [...LANGUAGE_IDS])
    assert.deepStrictEqual(
      ['dart', 'shell', 'sql', 'html', 'css'].map(id => [languageLabel(id), languageAbbreviation(id)]),
      [['Dart', 'Dart'], ['Shell', 'Sh'], ['SQL', 'SQL'], ['HTML', 'HTML'], ['CSS', 'CSS']])
    assert.strictEqual(languageAbbreviation('kotlin'), 'Kt')
    assert.strictEqual(languageAbbreviation('cobol'), '—')
  })

  test('Vue/Svelte components count as TypeScript when the session touched TypeScript, else JavaScript', () => {
    // Path alone: JavaScript.
    assert.strictEqual(languageForPath('/r/App.vue'), 'javascript')
    assert.strictEqual(languageForPath('/r/Card.Svelte'), 'javascript')
    // With any TypeScript file (even read-only) in the session, components join TypeScript.
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/App.vue', '/r/Nav.vue', '/r/x.py', '/r/y.py'], filesRead: ['/r/store.ts'] }),
      { language: 'typescript', languageSecondary: 'python' })
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/Card.svelte', '/r/lib.mts'] }),
      { language: 'typescript', languageSecondary: null })
    // Without TypeScript they are JavaScript, alongside any real .js files.
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/App.vue', '/r/main.js', '/r/site.css'] }),
      { language: 'javascript', languageSecondary: 'css' })
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/Card.svelte'] }),
      { language: 'javascript', languageSecondary: null })
  })

  test('a mixed session: most distinct files wins, runner-up is secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({
      filesRead: ['/r/a.py', '/r/b.py', '/r/c.py', '/r/web/app.ts'],
      filesChanged: ['/r/web/app.ts', '/r/web/util.ts', '/r/run.sh'],
    }), { language: 'python', languageSecondary: 'typescript' })
  })

  test('a README/config-only session is named by its files: most distinct kind wins, runner-up is secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({
      filesRead: ['/r/README.md', '/r/package.json', '/r/.env', '/r/config.yaml', '/r/settings.ini', '/r/pom.xml', '/r/logo.png', '/r/data.csv', '/r/notes.txt'],
      filesChanged: ['/r/CHANGELOG.md', '/r/tsconfig.json', '/r/Cargo.toml', '/r/.eslintrc.js'],
    }), { language: 'config', languageSecondary: 'docs' })
  })

  test('code always wins over docs/config, and never takes a non-code secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({
      filesChanged: ['/r/a.md', '/r/b.md', '/r/c.md', '/r/d.json', '/r/x.ts'],
    }), { language: 'typescript', languageSecondary: null })
  })

  test('each non-code category, by extension and by well-known name', () => {
    const one = (f: string) => deriveSessionLanguage({ filesChanged: [f] }).language
    for (const f of ['/r/README.md', '/r/guide.MDX', '/r/notes.txt', '/r/index.rst', '/r/LICENSE', '/r/CODEOWNERS']) assert.strictEqual(one(f), 'docs', f)
    for (const f of ['/r/a.json', '/r/b.yml', '/r/Cargo.toml', '/r/.gitignore', '/r/.eslintrc.js', '/r/Dockerfile', '/r/Dockerfile.dev', '/r/Makefile', '/r/go.mod', '/r/yarn.lock', '/r/main.tf']) assert.strictEqual(one(f), 'config', f)
    for (const f of ['/r/a.csv', '/r/b.tsv', '/r/c.jsonl', '/r/d.parquet', '/r/e.xlsx', '/r/app.sqlite']) assert.strictEqual(one(f), 'data', f)
    for (const f of ['/r/logo.png', '/r/icon.SVG', '/r/font.woff2', '/r/demo.mp4']) assert.strictEqual(one(f), 'assets', f)
  })

  test('no path at all is no_files; only unrecognised files is none — neither has a secondary', () => {
    assert.deepStrictEqual(deriveSessionLanguage({}), { language: 'no_files', languageSecondary: null })
    assert.deepStrictEqual(deriveSessionLanguage({ filesRead: [], filesChanged: [] }), { language: 'no_files', languageSecondary: null })
    assert.deepStrictEqual(deriveSessionLanguage({ filesRead: ['/r/blob.weird', '/r/LICENSE-MIT'] }), { language: 'none', languageSecondary: null })
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
    assert.strictEqual(languageForPath('/r/q.scala'), 'other')
    assert.strictEqual(languageForPath('/r/init.lua'), 'other')
    assert.strictEqual(languageForPath('/r/blob.weird'), null)
    assert.strictEqual(languageForPath('/r/Makefile'), null)
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/a.ts', '/r/b.ts', '/r/deploy.ps1', '/r/x.weird'] }),
      { language: 'typescript', languageSecondary: 'other' })
    assert.deepStrictEqual(deriveSessionLanguage({ filesChanged: ['/r/a.lua', '/r/b.scala'] }),
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

  test('languageFromRecord re-derives a stored none (written before the non-code categories), and keeps tiers apart', () => {
    assert.deepStrictEqual(languageFromRecord({ language: 'none' }, { filesChanged: ['/r/README.md'] }), { language: 'docs', languageSecondary: null })
    assert.deepStrictEqual(languageFromRecord({ language: 'none' }, {}), { language: 'no_files', languageSecondary: null })
    assert.deepStrictEqual(languageFromRecord({ language: 'docs', languageSecondary: 'config' }, {}), { language: 'docs', languageSecondary: 'config' })
    assert.deepStrictEqual(languageFromRecord({ language: 'rust', languageSecondary: 'docs' }, {}), { language: 'rust', languageSecondary: null })
    assert.deepStrictEqual(languageFromRecord({ language: 'docs', languageSecondary: 'rust' }, {}), { language: 'docs', languageSecondary: null })
    assert.deepStrictEqual(languageFromRecord({ language: 'no_files', languageSecondary: 'docs' }, {}), { language: 'no_files', languageSecondary: null })
  })

  test('labels for the non-code ids', () => {
    assert.deepStrictEqual(
      ['docs', 'config', 'data', 'assets', 'none', 'no_files'].map(id => [languageLabel(id), languageAbbreviation(id)]),
      [['Docs', 'Docs'], ['Config', 'Cfg'], ['Data', 'Data'], ['Assets', 'Asset'], ['No code', 'None'], ['No files', 'Nil']])
  })
})
