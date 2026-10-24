import * as assert from 'assert'
import { spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// desktop/scripts/winget-manifests.mjs is what release.yml's publish-winget job runs against the
// Windows installers it downloads from the release; run it the same way.
const SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'desktop', 'scripts', 'winget-manifests.mjs')
const V = '1.2.3'
const DIR = ['manifests', 't', 'TraceRoost', 'TraceRoost', V]

suite('winget-manifests — the winget package for a desktop release', () => {
  let dir: string
  let assets: string
  let out: string
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-winget-'))
    assets = path.join(dir, 'assets')
    out = path.join(dir, 'out')
    fs.mkdirSync(assets)
  })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex').toUpperCase()
  function asset(name: string) { fs.writeFileSync(path.join(assets, name), name) }
  function run() {
    const r = spawnSync(process.execPath, [SCRIPT, '--version', V, '--assets', assets, '--out', out], { encoding: 'utf8' })
    return { status: r.status, err: r.stderr }
  }
  const read = (file: string) => fs.readFileSync(path.join(out, ...DIR, file), 'utf8')

  test('preview installers: the three manifests in the winget-pkgs layout, hashed from the bytes', () => {
    asset(`TraceRoost-${V}-win-x64-preview.exe`)
    asset(`TraceRoost-${V}-win-arm64-preview.exe`)
    assert.strictEqual(run().status, 0)
    assert.deepStrictEqual(fs.readdirSync(path.join(out, ...DIR)).sort(), [
      'TraceRoost.TraceRoost.installer.yaml', 'TraceRoost.TraceRoost.locale.en-US.yaml', 'TraceRoost.TraceRoost.yaml',
    ])
    const installer = read('TraceRoost.TraceRoost.installer.yaml')
    assert.match(installer, /^InstallerType: nullsoft$/m)
    assert.match(installer, /^Scope: user$/m)
    for (const arch of ['x64', 'arm64']) {
      const name = `TraceRoost-${V}-win-${arch}-preview.exe`
      assert.ok(installer.includes(`- Architecture: ${arch}\n  InstallerUrl: https://github.com/traceroost/core/releases/download/v${V}/${name}\n  InstallerSha256: ${sha(name)}\n`), arch)
    }
    assert.match(read('TraceRoost.TraceRoost.yaml'), new RegExp(`^PackageVersion: ${V.replace(/\./g, '\\.')}$`, 'm'))
    assert.match(read('TraceRoost.TraceRoost.locale.en-US.yaml'), /^Publisher: TraceRoost$/m)
  })

  test('a signed installer is preferred over a preview of the same architecture', () => {
    asset(`TraceRoost-${V}-win-x64.exe`)
    asset(`TraceRoost-${V}-win-x64-preview.exe`)
    asset(`TraceRoost-${V}-win-arm64-preview.exe`)
    assert.strictEqual(run().status, 0)
    const installer = read('TraceRoost.TraceRoost.installer.yaml')
    assert.ok(installer.includes(`/TraceRoost-${V}-win-x64.exe\n`))
    assert.ok(!installer.includes(`win-x64-preview.exe`))
  })

  test('a missing architecture fails rather than publishing a half package', () => {
    asset(`TraceRoost-${V}-win-x64-preview.exe`)
    const r = run()
    assert.strictEqual(r.status, 1)
    assert.match(r.err, /no Windows arm64 installer/)
    assert.ok(!fs.existsSync(out))
  })
})
