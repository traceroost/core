import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  assertRuntimeSupportsCollector, MIN_COLLECTOR_NODE_MAJOR, resolveCollectorResources,
} from './resources'

suite('resources — runtime check', () => {
  test('the Node the collector requires is accepted', () => {
    assertRuntimeSupportsCollector(`${MIN_COLLECTOR_NODE_MAJOR}.21.0`)
    assertRuntimeSupportsCollector(`v${MIN_COLLECTOR_NODE_MAJOR + 2}.0.0`)
  })

  test('an Electron upgrade that regressed the bundled Node fails loudly', () => {
    assert.throws(
      () => assertRuntimeSupportsCollector(`${MIN_COLLECTOR_NODE_MAJOR - 1}.9.0`),
      /requires Node >=24/,
    )
  })

  test('an unparseable runtime version is a failure, not a pass', () => {
    assert.throws(() => assertRuntimeSupportsCollector('unknown'), /requires Node/)
  })
})

suite('resources — staged tree', () => {
  let dir: string
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-desktop-res-')) })
  teardown(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))

  /** `manifest: 'none'` stages the tree without a package.json at all. */
  function stage(root: string, manifest: unknown | 'none' = { name: 'traceroost', version: '0.19.1' }) {
    fs.mkdirSync(path.join(root, 'standalone'), { recursive: true })
    fs.writeFileSync(path.join(root, 'standalone', 'server.js'), '// collector')
    if (manifest !== 'none') fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest))
  }

  test('packaged, the tree is read from the app\'s resources', () => {
    const root = path.join(dir, 'Resources', 'collector')
    stage(root)
    const resolved = resolveCollectorResources({ isPackaged: true, resourcesPath: path.join(dir, 'Resources'), devRoot: '/unused' })
    assert.strictEqual(resolved.root, root)
    assert.strictEqual(resolved.serverScript, path.join(root, 'standalone', 'server.js'))
    assert.strictEqual(resolved.version, '0.19.1')
  })

  test('in development it is the staged tree under desktop/', () => {
    const root = path.join(dir, 'resources', 'collector')
    stage(root)
    const resolved = resolveCollectorResources({ isPackaged: false, resourcesPath: '/unused', devRoot: dir })
    assert.strictEqual(resolved.root, root)
  })

  test('a missing collector is reported with the fix, not as a generic ENOENT later', () => {
    assert.throws(
      () => resolveCollectorResources({ isPackaged: false, resourcesPath: '/unused', devRoot: dir }),
      /pnpm run stage/,
    )
    assert.throws(
      () => resolveCollectorResources({ isPackaged: true, resourcesPath: dir, devRoot: '/unused' }),
      /build is incomplete/,
    )
  })

  test('an unreadable manifest degrades to an unknown version rather than failing to start', () => {
    const root = path.join(dir, 'resources', 'collector')
    stage(root, 'none')
    assert.strictEqual(resolveCollectorResources({ isPackaged: false, resourcesPath: '/u', devRoot: dir }).version, 'unknown')
  })
})
