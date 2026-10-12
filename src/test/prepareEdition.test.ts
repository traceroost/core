import * as assert from 'assert'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'

// scripts/prepare-edition.mjs is an ES module script; run its exported coreChangelog() in a child
// Node process (importing it does not rewrite anything — it only acts when run as a script).
const root = path.resolve(__dirname, '../../..')
const scriptUrl = pathToFileURL(path.join(root, 'scripts', 'prepare-edition.mjs')).href

function coreChangelog(text: string): string {
  const code = `import { coreChangelog } from ${JSON.stringify(scriptUrl)}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => process.stdout.write(coreChangelog(input)))`
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { input: text, encoding: 'utf8' })
}

const HEADING = '### TraceRoost Cloud (full edition only)'

suite('prepare-edition core — CHANGELOG', () => {
  test('drops each cloud-only section up to the next heading or rule, and nothing else', () => {
    const input = [
      '# Changelog', '', '## [Unreleased]', '', '### Fixed', '', '- core fix', '',
      HEADING, '', 'Intro.', '', '- cloud fix', '', '---', '',
      '## [1.0.0]', '', '### Added', '', '- core add', '',
      HEADING, '', '- old cloud add', '', '### Changed', '', '- core change', '',
    ].join('\n')
    const out = coreChangelog(input)
    assert.ok(!out.includes('TraceRoost Cloud'), out)
    assert.ok(!out.includes('cloud fix') && !out.includes('old cloud add'), out)
    for (const kept of ['- core fix', '---', '## [1.0.0]', '- core add', '### Changed', '- core change']) {
      assert.ok(out.includes(kept), `lost ${kept}`)
    }
    assert.ok(!/\n{3,}/.test(out), 'left a run of blank lines behind')
  })

  test('the real CHANGELOG keeps every version and loses only its cloud sections', () => {
    const real = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
    const out = coreChangelog(real)
    assert.ok(!out.includes(HEADING))
    const versions = (t: string) => t.match(/^## \[[^\]]+\]/gm) ?? []
    assert.deepStrictEqual(versions(out), versions(real))
  })

  test('a changelog without a cloud section is left as it was', () => {
    const input = '# Changelog\n\n## [1.0.0]\n\n- a\n'
    assert.strictEqual(coreChangelog(input), input)
  })
})
