import * as assert from 'assert'
import * as http from 'http'
import * as net from 'net'
import { startMcpHttpServer, MAX_MCP_BODY_BYTES } from '../mcpServer'
import type { SessionSummaryCard } from '../summarizers/summarizerTypes'

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

// startMcpHttpServer gives every request its own SDK Server and transport. (The SDK refuses a
// second connect on a Server that is still connected — "Already connected" — so a shared Server
// only worked while every tool handler was synchronous.) These pin down that overlapping requests
// each get their own answer, and a client that drops mid-request doesn't wedge later requests.
suite('mcpServer concurrent requests', () => {
  let server: http.Server
  let port: number
  const sessions = Array.from({ length: 200 }, (_, i) => ({
    sessionId: `s${i}`, traceId: `t${i}`, source: 'claude_code', dataSource: 'log', workspace: `/w${i}`,
    userRequest: `request ${i}`, model: 'm', turns: 1, inputTokens: i, outputTokens: 0, cacheReadTokens: 0,
    cacheCreateTokens: 0, cacheHitRate: 0, durationMs: 1, startTime: new Date(1e12 + i * 1000).toISOString(),
    filesRead: [], filesSearched: [], filesChanged: [], filesWritten: [], toolCounts: {}, totalToolCalls: 0,
    totalLlmCalls: 0, errors: 0, outcome: 'tool_calls', timeline: [], backgroundSpans: [], loopSignals: [],
  }) as unknown as SessionSummaryCard)

  setup(async () => {
    server = await startMcpHttpServer({ getSessions: () => sessions }, 16316 + Math.floor(Math.random() * 1000))
    port = (server.address() as { port: number }).port
  })

  teardown(() => new Promise<void>(resolve => server.close(() => resolve())))

  const detail = (i: number) => JSON.stringify({ jsonrpc: '2.0', id: 1000 + i, method: 'tools/call', params: { name: 'get_session_detail', arguments: { sessionId: `s${i}` } } })

  test('each of many overlapping requests gets its own response', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => send(port, { body: detail(i), headers: MCP_HEADERS })))
    results.forEach((res, i) => {
      assert.strictEqual(res.status, 200, res.body)
      assert.ok(res.body.includes(`"id":${1000 + i}`), res.body)
      assert.ok(res.body.includes(`request ${i}`), res.body)
    })
  })

  test('clients that disconnect right after sending do not wedge the server', async () => {
    const body = detail(1)
    await Promise.all(Array.from({ length: 20 }, () => new Promise<void>(resolve => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
          `Accept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        sock.destroy()
        resolve()
      })
      sock.on('error', () => resolve())
    })))
    await new Promise(r => setTimeout(r, 100))
    const res = await send(port, { body: detail(7), headers: MCP_HEADERS })
    assert.strictEqual(res.status, 200, res.body)
    assert.ok(res.body.includes('request 7'))
  })
})
