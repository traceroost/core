import * as assert from 'assert'
import { spawnSync } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// desktop/scripts/release-assets.mjs is what desktop-release.yml runs between the build artifacts and
// the GitHub release; run it as the workflow does, against artifact directories laid out the way
// actions/download-artifact leaves them.
const SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'desktop', 'scripts', 'release-assets.mjs')
const V = '1.2.3'
const MAC = ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `TraceRoost-${V}-mac-${arch}.${ext}`))
const LINUX_X64 = [`TraceRoost-${V}-linux-amd64.deb`, `TraceRoost-${V}-linux-x86_64.AppImage`]
const LINUX_ARM64 = [`TraceRoost-${V}-linux-arm64.deb`, `TraceRoost-${V}-linux-arm64.AppImage`]
const SUMS = `TraceRoost-desktop-${V}-SHA256SUMS`

suite('release-assets — attaching desktop builds to a release', () => {
  let dir: string
  let inDir: string
  let outDir: string
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-release-assets-'))
    inDir = path.join(dir, 'artifacts')
    outDir = path.join(dir, 'release')
  })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** One uploaded artifact: the files (content = their name) and the SHA256SUMS its build wrote. */
  function artifact(name: string, files: string[], sums = files) {
    const at = path.join(inDir, name)
    fs.mkdirSync(at, { recursive: true })
    for (const file of files) fs.writeFileSync(path.join(at, file), file)
    const hash = (file: string) => crypto.createHash('sha256').update(file).digest('hex')
    fs.writeFileSync(path.join(at, 'SHA256SUMS'), sums.map(f => `${hash(f)}  ${f}`).join('\n') + '\n')
    fs.writeFileSync(path.join(at, 'THIRD_PARTY_NOTICES.md'), 'notices')
    return at
  }

  function allArtifacts() {
    artifact('traceroost-desktop-macos', MAC)
    artifact('traceroost-desktop-linux-x64', LINUX_X64)
    artifact('traceroost-desktop-linux-arm64', LINUX_ARM64)
  }

  function run(platforms = 'linux', ...extra: string[]) {
    const r = spawnSync(process.execPath, [SCRIPT, '--in', inDir, '--out', outDir, '--version', V, '--platforms', platforms, ...extra], { encoding: 'utf8' })
    return { status: r.status, out: r.stdout, err: r.stderr }
  }

  function released() {
    return fs.existsSync(outDir) ? fs.readdirSync(outDir).sort() : []
  }

  test('Linux alone: the (unnotarized) macOS files are verified and left out', () => {
    allArtifacts()
    const r = run()
    assert.strictEqual(r.status, 0, r.err)
    assert.deepStrictEqual(released(), [...LINUX_X64, ...LINUX_ARM64, SUMS].sort())
    assert.match(r.out, /not attached \(platform not released\): .*mac-arm64\.dmg/)
  })

  test('both platforms: every installer is attached', () => {
    allArtifacts()
    const r = run('linux,macos')
    assert.strictEqual(r.status, 0, r.err)
    assert.deepStrictEqual(released(), [...MAC, ...LINUX_X64, ...LINUX_ARM64, SUMS].sort())
  })

  test('the combined SHA256SUMS covers exactly the attached files and verifies them', () => {
    allArtifacts()
    assert.strictEqual(run().status, 0)
    const lines = fs.readFileSync(path.join(outDir, SUMS), 'utf8').trim().split('\n')
    assert.deepStrictEqual(lines.map(l => l.split('  ')[1]), [...LINUX_X64, ...LINUX_ARM64].sort())
    for (const line of lines) {
      const [hash, name] = line.split('  ')
      const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(outDir, name))).digest('hex')
      assert.strictEqual(actual, hash, name)
    }
  })

  test('a file altered after its build wrote SHA256SUMS fails the release', () => {
    allArtifacts()
    fs.appendFileSync(path.join(inDir, 'traceroost-desktop-linux-x64', LINUX_X64[0]), 'tampered')
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /does not match its checksum/)
    assert.deepStrictEqual(released(), [], 'attached something despite the mismatch')
  })

  test('a missing architecture fails the release rather than publishing half of it', () => {
    artifact('traceroost-desktop-macos', MAC)
    artifact('traceroost-desktop-linux-x64', LINUX_X64)
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /missing from the build artifacts: .*linux-arm64\.deb/)
  })

  test('asking for macOS without the macOS build fails', () => {
    artifact('traceroost-desktop-linux-x64', LINUX_X64)
    artifact('traceroost-desktop-linux-arm64', LINUX_ARM64)
    const r = run('linux,macos')
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /missing .*mac-arm64\.dmg/)
  })

  test('macOS alone, when the Linux build failed and uploaded nothing', () => {
    artifact('traceroost-desktop-macos', MAC)
    const r = run('macos')
    assert.strictEqual(r.status, 0, r.err)
    assert.deepStrictEqual(released(), [...MAC, SUMS].sort())
  })

  test('no platform to release is an error, not an empty release', () => {
    allArtifacts()
    const r = run('')
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /names no platform/)
  })

  test('an unknown platform (windows, for now) is refused', () => {
    allArtifacts()
    const r = run('linux,windows')
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /unknown platform windows/)
  })

  test('installers built for another version (tag and package.json disagree) fail', () => {
    artifact('traceroost-desktop-linux-x64', LINUX_X64.map(f => f.replace(V, '1.2.2')))
    artifact('traceroost-desktop-linux-arm64', LINUX_ARM64)
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /unexpected files for 1\.2\.3: TraceRoost-1\.2\.2-linux-amd64\.deb/)
  })

  test('a file listed in SHA256SUMS but absent from the artifact fails', () => {
    artifact('traceroost-desktop-linux-x64', [LINUX_X64[0]], LINUX_X64)
    artifact('traceroost-desktop-linux-arm64', LINUX_ARM64)
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /which is not in the artifact/)
  })

  test('the same installer in two artifacts fails', () => {
    allArtifacts()
    artifact('traceroost-desktop-linux-x64-again', LINUX_X64)
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /appears in two artifacts/)
  })

  test('a SHA256SUMS entry that is a path, not a file name, fails', () => {
    allArtifacts()
    const sums = path.join(inDir, 'traceroost-desktop-linux-x64', 'SHA256SUMS')
    fs.appendFileSync(sums, `${'0'.repeat(64)}  ../../etc/passwd\n`)
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /lists a path/)
  })

  test('a malformed SHA256SUMS line fails', () => {
    allArtifacts()
    fs.appendFileSync(path.join(inDir, 'traceroost-desktop-macos', 'SHA256SUMS'), 'not a checksum line\n')
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /unreadable line/)
  })

  test('no artifacts at all fails', () => {
    fs.mkdirSync(inDir, { recursive: true })
    const r = run()
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /no SHA256SUMS/)
  })

  test('a version that is not semver (a tag name with its v, say) is refused', () => {
    allArtifacts()
    const r = spawnSync(process.execPath, [SCRIPT, '--in', inDir, '--out', outDir, '--version', `v${V}`, '--platforms', 'linux'], { encoding: 'utf8' })
    assert.notStrictEqual(r.status, 0)
    assert.match(r.stderr, /must be a semver version/)
  })

  test('a mistyped flag is refused rather than ignored', () => {
    allArtifacts()
    const r = run('linux', '--mac')
    assert.notStrictEqual(r.status, 0)
    assert.match(r.err, /unknown argument --mac/)
  })
})
