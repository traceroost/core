import * as assert from 'assert'
import * as http from 'http'
import { startMcpHttpServer, MAX_MCP_BODY_BYTES } from '../mcpServer'

function send(port: number, opts: {
  method?: string; body?: string; headers?: Record<string, string>
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? ''
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: opts.method ?? 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...opts.headers },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const LIST_TOOLS = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

suite('mcpServer HTTP hardening', () => {
  let server: http.Server
  let port: number

  setup(async () => {
    server = await startMcpHttpServer({ getSessions: () => [] }, 15316 + Math.floor(Math.random() * 1000))
    port = (server.address() as { port: number }).port
  })

  teardown(() => new Promise<void>(resolve => server.close(() => resolve())))

  test('serves an MCP client that sends no Origin, with no CORS headers', async () => {
    const res = await send(port, { body: LIST_TOOLS, headers: MCP_HEADERS })
    assert.strictEqual(res.status, 200)
    assert.ok(res.body.includes('get_recent_sessions'))
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined)
  })

  test('refuses a request from another website', async () => {
    const res = await send(port, { body: LIST_TOOLS, headers: { ...MCP_HEADERS, Origin: 'https://evil.example' } })
    assert.strictEqual(res.status, 403)
    assert.ok(!res.body.includes('get_recent_sessions'))
  })

  test('does not answer a CORS preflight with allow headers', async () => {
    const res = await send(port, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    })
    assert.strictEqual(res.status, 403)
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined)
  })

  test('rejects an oversized body with 413', async () => {
    const res = await send(port, { body: 'x'.repeat(MAX_MCP_BODY_BYTES + 1), headers: MCP_HEADERS })
    assert.strictEqual(res.status, 413)
  })
})
