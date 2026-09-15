import * as assert from 'assert'
import * as http from 'http'
import { startCallbackServer } from '../../../cloud/team/callbackServer'

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    }).on('error', reject)
  })
}

function isListening(url: string): Promise<boolean> {
  return get(url).then(() => true).catch(() => false)
}

suite('team/callbackServer', () => {
  test('binds a random loopback port and resolves the callback query', async () => {
    const server = await startCallbackServer()
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(server.redirectUri))
    const wait = server.waitForCallback()
    const res = await get(`${server.redirectUri}?code=abc123&state=xyz`)
    assert.strictEqual(res.status, 200)
    assert.match(res.body, /Machine linked/)
    const result = await wait
    assert.deepStrictEqual(result, { code: 'abc123', state: 'xyz' })
  })

  test('the listener cannot outlive success', async () => {
    const server = await startCallbackServer()
    const wait = server.waitForCallback()
    await get(`${server.redirectUri}?code=c&state=s`)
    await wait
    assert.strictEqual(await isListening(server.redirectUri), false)
  })

  test('an error callback responds to the browser, then rejects, then closes', async () => {
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

  test('a team_url matching teamOrigin appears as a link on the success page', async () => {
    const server = await startCallbackServer({ teamOrigin: 'https://test.traceroost.com' })
    const wait = server.waitForCallback()
    const teamUrl = encodeURIComponent('https://test.traceroost.com/acme1')
    const res = await get(`${server.redirectUri}?code=abc&state=s&team_url=${teamUrl}`)
    assert.match(res.body, /href="https:\/\/test\.traceroost\.com\/acme1"/)
    await wait
  })

  test('a team_url on a different origin than teamOrigin is dropped, not linked', async () => {
    const server = await startCallbackServer({ teamOrigin: 'https://test.traceroost.com' })
    const wait = server.waitForCallback()
    const teamUrl = encodeURIComponent('https://evil.example.com/acme1')
    const res = await get(`${server.redirectUri}?code=abc&state=s&team_url=${teamUrl}`)
    assert.ok(!res.body.includes('evil.example.com'))
    assert.match(res.body, /Machine linked/)
    await wait
  })

  test('a team_url with no configured teamOrigin is dropped, not linked', async () => {
    const server = await startCallbackServer()
    const wait = server.waitForCallback()
    const teamUrl = encodeURIComponent('https://test.traceroost.com/acme1')
    const res = await get(`${server.redirectUri}?code=abc&state=s&team_url=${teamUrl}`)
    assert.ok(!res.body.includes('href='))
    await wait
  })
})
