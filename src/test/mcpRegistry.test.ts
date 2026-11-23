import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'

// server.json is the official MCP Registry entry, published by release.yml's publish-mcp-registry
// job. The registry refuses it unless the npm package it names carries the same name in
// package.json's `mcpName`, so a rename on either side must change both.

const root = path.resolve(__dirname, '../../..')
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))

suite('MCP Registry entry (server.json)', () => {
  const server = read('server.json')
  const pkg = read('package.json')

  test("server.json's name is package.json's mcpName", () => {
    assert.strictEqual(server.name, pkg.mcpName)
  })

  test('its one npm package is this package, served over HTTP on the --mcp-port the CLI takes', () => {
    assert.strictEqual(server.packages.length, 1)
    const [p] = server.packages
    assert.strictEqual(p.registryType, 'npm')
    assert.strictEqual(p.identifier, pkg.name)
    assert.deepStrictEqual(p.transport, { type: 'streamable-http', url: 'http://localhost:{--mcp-port}/mcp' })
    assert.deepStrictEqual(p.packageArguments.map((a: { name: string }) => a.name), ['--mcp-port'])
    assert.strictEqual(p.packageArguments[0].default, '4316')
  })

  test('the description fits the registry\'s 100-character limit', () => {
    assert.ok(server.description.length <= 100, `${server.description.length} characters`)
  })
})
