import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { brewExecutable, brewFormulaRef, describeBrewFailure, detectHomebrewInstall, findHomebrewCopy, homebrewPrefixes, readHomebrewVersion, stableNodePath } from './homebrew'

suite('homebrew', () => {
  let prefix: string
  setup(() => { prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-brew-'))) })
  teardown(() => { fs.rmSync(prefix, { recursive: true, force: true }) })

  /** A keg laid out the way `npm install *std_npm_args` + `bin.install_symlink` leaves it, with
   *  the `opt` and `bin` links Homebrew adds. */
  function makeKeg(version: string, link = true): { cli: string; binLink: string } {
    const pkg = path.join(prefix, 'Cellar', 'traceroost', version, 'libexec', 'lib', 'node_modules', 'traceroost')
    fs.mkdirSync(path.join(pkg, 'standalone'), { recursive: true })
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'traceroost', version }))
    const cli = path.join(pkg, 'standalone', 'cli.js')
    fs.writeFileSync(cli, '')
    const binLink = path.join(prefix, 'bin', 'traceroost')
    if (link) {
      fs.mkdirSync(path.join(prefix, 'opt'), { recursive: true })
      fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true })
      fs.rmSync(path.join(prefix, 'opt', 'traceroost'), { force: true })
      fs.symlinkSync(path.join(prefix, 'Cellar', 'traceroost', version), path.join(prefix, 'opt', 'traceroost'), 'dir')
      fs.rmSync(binLink, { force: true })
      fs.symlinkSync(cli, binLink)
    }
    return { cli, binLink }
  }

  const optCli = () => path.join(prefix, 'opt', 'traceroost', 'libexec', 'lib', 'node_modules', 'traceroost', 'standalone', 'cli.js')

  test('a Cellar cli.js maps to its stable opt path', function () {
    if (process.platform === 'win32') this.skip()
    const { cli } = makeKeg('0.19.0')
    const install = detectHomebrewInstall(cli, 'traceroost')
    assert.ok(install)
    assert.strictEqual(install.prefix, prefix)
    assert.strictEqual(install.formula, 'traceroost')
    assert.strictEqual(install.stableCliPath, optCli())
    assert.strictEqual(readHomebrewVersion(install), '0.19.0')
  })

  test('launched through the <prefix>/bin symlink, as a shell does', function () {
    if (process.platform === 'win32') this.skip()
    const { binLink } = makeKeg('0.19.0')
    assert.strictEqual(detectHomebrewInstall(binLink, 'traceroost')?.stableCliPath, optCli())
  })

  test('the opt path keeps naming the current version after an upgrade', function () {
    if (process.platform === 'win32') this.skip()
    makeKeg('0.19.0')
    const { cli } = makeKeg('0.20.0')
    const install = detectHomebrewInstall(cli, 'traceroost')
    assert.ok(install)
    assert.strictEqual(install.stableCliPath, optCli())
    assert.strictEqual(readHomebrewVersion(install), '0.20.0')
  })

  test('npm global installs, npx caches and checkouts are not Homebrew', () => {
    assert.strictEqual(detectHomebrewInstall('/usr/local/lib/node_modules/traceroost/standalone/cli.js', 'traceroost'), undefined)
    assert.strictEqual(detectHomebrewInstall('/Users/a/.npm/_npx/abc/node_modules/traceroost/standalone/cli.js', 'traceroost'), undefined)
    assert.strictEqual(detectHomebrewInstall('/Users/a/src/core/standalone/cli.js', 'traceroost'), undefined)
    assert.strictEqual(detectHomebrewInstall('', 'traceroost'), undefined)
  })

  test('a Cellar path for some other package is not ours', function () {
    if (process.platform === 'win32') this.skip()
    makeKeg('0.19.0')
    const other = path.join(prefix, 'Cellar', 'traceroost', '0.19.0', 'libexec', 'lib', 'node_modules', 'other', 'cli.js')
    assert.strictEqual(detectHomebrewInstall(other, 'traceroost'), undefined)
  })

  test("Homebrew's own node maps to opt/node; any other node is kept", function () {
    if (process.platform === 'win32') this.skip()
    const kegNode = path.join(prefix, 'Cellar', 'node', '24.9.0', 'bin', 'node')
    fs.mkdirSync(path.dirname(kegNode), { recursive: true })
    fs.writeFileSync(kegNode, '')
    fs.mkdirSync(path.join(prefix, 'opt'), { recursive: true })
    fs.symlinkSync(path.join(prefix, 'Cellar', 'node', '24.9.0'), path.join(prefix, 'opt', 'node'), 'dir')
    assert.strictEqual(stableNodePath(kegNode), path.join(prefix, 'opt', 'node', 'bin', 'node'))
    assert.strictEqual(stableNodePath('/Users/a/.nvm/versions/node/v24.9.0/bin/node'), '/Users/a/.nvm/versions/node/v24.9.0/bin/node')
  })

  test('a versioned node@N keg without its opt link is left as is', function () {
    if (process.platform === 'win32') this.skip()
    const kegNode = path.join(prefix, 'Cellar', 'node@24', '24.9.0', 'bin', 'node')
    fs.mkdirSync(path.dirname(kegNode), { recursive: true })
    fs.writeFileSync(kegNode, '')
    assert.strictEqual(stableNodePath(kegNode), kegNode)
  })

  test('brew is found under the prefix, and its failures read plainly', () => {
    assert.strictEqual(brewExecutable('/opt/homebrew'), path.join('/opt/homebrew', 'bin', 'brew'))
    assert.strictEqual(describeBrewFailure({ code: 'ENOENT' }), 'brew was not found')
    assert.strictEqual(describeBrewFailure({ status: 1 }), 'brew exited with code 1 — see its output above')
  })

  test('finds an installed Homebrew copy through its opt link, for npx to hand off to', function () {
    if (process.platform === 'win32') this.skip()
    assert.strictEqual(findHomebrewCopy('traceroost', [prefix]), undefined)
    makeKeg('0.19.1')
    const found = findHomebrewCopy('traceroost', [path.join(prefix, 'missing'), prefix])
    assert.ok(found)
    assert.strictEqual(found.stableCliPath, optCli())
  })

  test('HOMEBREW_PREFIX is searched first, then the standard prefixes, without duplicates', () => {
    assert.deepStrictEqual(homebrewPrefixes({ HOMEBREW_PREFIX: '/opt/homebrew' }), ['/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew'])
    assert.deepStrictEqual(homebrewPrefixes({ HOMEBREW_PREFIX: '/custom' })[0], '/custom')
  })

  test('brew upgrade gets the tap-qualified name from the install receipt', function () {
    if (process.platform === 'win32') this.skip()
    const { cli } = makeKeg('0.19.1')
    const install = detectHomebrewInstall(cli, 'traceroost')
    assert.ok(install)
    assert.strictEqual(brewFormulaRef(install), 'traceroost', 'no receipt: the bare name')
    const receipt = path.join(prefix, 'Cellar', 'traceroost', '0.19.1', 'INSTALL_RECEIPT.json')
    fs.writeFileSync(receipt, JSON.stringify({ source: { tap: 'traceroost/tap' } }))
    assert.strictEqual(brewFormulaRef(install), 'traceroost/tap/traceroost')
    fs.writeFileSync(receipt, JSON.stringify({ source: { tap: 'x; rm -rf /' } }))
    assert.strictEqual(brewFormulaRef(install), 'traceroost', 'an odd tap name is ignored')
  })
})
