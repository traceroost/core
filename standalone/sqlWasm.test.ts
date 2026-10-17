import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { sqlWasmDir } from './sqlWasm'

suite('sqlWasm', () => {
  test('prefers the wasm shipped in this package\'s dist/, next to the bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-sqlwasm-'))
    try {
      const dist = path.join(root, 'dist')
      fs.mkdirSync(dist)
      fs.writeFileSync(path.join(dist, 'sql-wasm.wasm'), '')
      assert.strictEqual(sqlWasmDir(path.join(root, 'standalone')), dist)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('falls back to node_modules/sql.js only when dist/ has no wasm (the unbundled test build)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-sqlwasm-'))
    try {
      const dir = sqlWasmDir(path.join(root, 'standalone'))
      assert.ok(dir, 'sql.js is a devDependency here, so the fallback resolves')
      assert.ok(fs.existsSync(path.join(dir!, 'sql-wasm.wasm')))
      assert.ok(dir!.split(path.sep).includes('sql.js'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
