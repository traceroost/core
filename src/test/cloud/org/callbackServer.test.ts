import * as assert from 'assert'
import * as http from 'http'
import { startCallbackServer } from '../../../cloud/org/callbackServer'

function get(url: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }))
    }).on('error', reject)
  })
}

function isListening(url: string): Promise<boolean> {
  return get(url).then(() => true).catch(() => false)
}

suite('org/callbackServer', () => {
  test('binds a random loopback port and resolves the callback query before responding', async () => {
    const server = await startCallbackServer()
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(server.redirectUri))
    const reqPromise = get(`${server.redirectUri}?code=abc123&state=xyz`)
    // The request has landed and the result is available, but nothing has been sent back yet —
    // that's the whole point (see callbackServer.ts's finish() doc).
    const result = await server.waitForCallback()
    assert.deepStrictEqual(result, { code: 'abc123', state: 'xyz' })
    server.finish(true)
    const res = await reqPromise
    assert.strictEqual(res.status, 200)
    assert.match(res.body, /Machine linked/)
  })

  test('finish(true) closes the listener; the response is not sent before it is called', async () => {
    const server = await startCallbackServer()
    const reqPromise = get(`${server.redirectUri}?code=c&state=s`)
    await server.waitForCallback()
    assert.strictEqual(await isListening(server.redirectUri), true, 'still open — finish() not called yet')
    server.finish(true)
    await reqPromise
    assert.strictEqual(await isListening(server.redirectUri), false)
  })

  test('an error callback responds to the browser immediately, then rejects, then closes', async () => {
    const server = await startCallbackServer()
    const wait = server.waitForCallback()
    const res = await get(`${server.redirectUri}?error=access_denied&state=s`)
    assert.strictEqual(res.status, 400)
    await assert.rejects(wait, /access_denied/)
    assert.strictEqual(await isListening(server.redirectUri), false)
  })

  test('a timeout closes the listener', async () => {
    const server = await startCallbackServer({ timeoutMs: 60 })
    await assert.rejects(server.waitForCallback(), /timed out/)
    assert.strictEqual(await isListening(server.redirectUri), false)
  })

  test('close() finishes a still-open good response instead of hanging it', async () => {
    const server = await startCallbackServer()
    const reqPromise = get(`${server.redirectUri}?code=c&state=s`)
    await server.waitForCallback()
    server.close()
    const res = await reqPromise
    assert.strictEqual(res.status, 400)
    assert.match(res.body, /Link failed/)
  })

  test('a org_url matching orgOrigin redirects straight there once finished', async () => {
    const server = await startCallbackServer({ orgOrigin: 'https://test.traceroost.com' })
    const orgUrl = encodeURIComponent('https://test.traceroost.com/acme1')
    const reqPromise = get(`${server.redirectUri}?code=abc&state=s&org_url=${orgUrl}`)
    await server.waitForCallback()
    server.finish(true)
    const res = await reqPromise
    assert.strictEqual(res.status, 302)
    assert.strictEqual(res.headers.location, 'https://test.traceroost.com/acme1')
  })

  test('a org_url on a different origin than orgOrigin is dropped, not linked', async () => {
    const server = await startCallbackServer({ orgOrigin: 'https://test.traceroost.com' })
    const orgUrl = encodeURIComponent('https://evil.example.com/acme1')
    const reqPromise = get(`${server.redirectUri}?code=abc&state=s&org_url=${orgUrl}`)
    await server.waitForCallback()
    server.finish(true)
    const res = await reqPromise
    assert.strictEqual(res.status, 200)
    assert.ok(!res.body.includes('evil.example.com'))
    assert.match(res.body, /Machine linked/)
  })

  test('a org_url with no configured orgOrigin is dropped, not linked', async () => {
    const server = await startCallbackServer()
    const orgUrl = encodeURIComponent('https://test.traceroost.com/acme1')
    const reqPromise = get(`${server.redirectUri}?code=abc&state=s&org_url=${orgUrl}`)
    await server.waitForCallback()
    server.finish(true)
    const res = await reqPromise
    assert.strictEqual(res.status, 200)
    assert.ok(!res.body.includes('href='))
  })

  test('finish(false) shows the failure page even for an otherwise-good callback', async () => {
    const server = await startCallbackServer()
    const reqPromise = get(`${server.redirectUri}?code=abc&state=s`)
    await server.waitForCallback()
    server.finish(false)
    const res = await reqPromise
    assert.strictEqual(res.status, 400)
    assert.match(res.body, /Link failed/)
  })
})
