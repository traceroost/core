import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { isPathInsideDir } from './globalInstall'

suite('isPathInsideDir', () => {
  let root: string
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-globalinstall-')) })
  teardown(() => { fs.rmSync(root, { recursive: true, force: true }) })

  function makeGlobalInstall(): { pkgDir: string; cli: string } {
    const pkgDir = path.join(root, 'lib', 'node_modules', 'traceroost')
    fs.mkdirSync(path.join(pkgDir, 'standalone'), { recursive: true })
    const cli = path.join(pkgDir, 'standalone', 'cli.js')
    fs.writeFileSync(cli, '')
    return { pkgDir, cli }
  }

  test('matches a file directly inside the dir and the dir itself', () => {
    const { pkgDir, cli } = makeGlobalInstall()
    assert.strictEqual(isPathInsideDir(cli, pkgDir), true)
    assert.strictEqual(isPathInsideDir(pkgDir, pkgDir), true)
  })

  test('matches when argv[1] is the npm global bin symlink (macOS/Linux)', function () {
    const { pkgDir, cli } = makeGlobalInstall()
    const binDir = path.join(root, 'bin')
    fs.mkdirSync(binDir)
    const binLink = path.join(binDir, 'traceroost')
    try { fs.symlinkSync(path.relative(binDir, cli), binLink) } catch { this.skip() }
    assert.strictEqual(isPathInsideDir(binLink, pkgDir), true)
  })

  test('matches when the npm prefix itself is reached through a symlinked dir', function () {
    const { pkgDir, cli } = makeGlobalInstall()
    const linkedRoot = path.join(os.tmpdir(), `${path.basename(root)}-link`)
    try { fs.symlinkSync(root, linkedRoot, 'dir') } catch { this.skip() }
    try {
      const viaLink = path.join(linkedRoot, path.relative(root, pkgDir))
      assert.strictEqual(isPathInsideDir(cli, viaLink), true)
      assert.strictEqual(isPathInsideDir(path.join(viaLink, 'standalone', 'cli.js'), pkgDir), true)
    } finally {
      fs.rmSync(linkedRoot, { force: true })
    }
  })

  test('rejects siblings, prefix look-alikes, and empty inputs', () => {
    const { pkgDir } = makeGlobalInstall()
    const lookAlike = `${pkgDir}-dev`
    fs.mkdirSync(path.join(lookAlike, 'standalone'), { recursive: true })
    assert.strictEqual(isPathInsideDir(path.join(lookAlike, 'standalone', 'cli.js'), pkgDir), false)
    assert.strictEqual(isPathInsideDir(path.join(root, 'checkout', 'standalone', 'cli.js'), pkgDir), false)
    assert.strictEqual(isPathInsideDir('', pkgDir), false)
    assert.strictEqual(isPathInsideDir(pkgDir, ''), false)
  })
})
