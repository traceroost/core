import * as assert from 'assert'
import * as http from 'http'
import { decodePathSegment, redactTokenInUrl, mayPrintFullUrl, REDACTED_TOKEN } from './requestGuards'

suite('requestGuards', () => {
  suite('decodePathSegment', () => {
    test('decodes a well-formed segment', () => {
      assert.strictEqual(decodePathSegment('abc%20def'), 'abc def')
      assert.strictEqual(decodePathSegment('claude%3A1234'), 'claude:1234')
    })

    test('returns null instead of throwing on a malformed escape', () => {
      assert.strictEqual(decodePathSegment('%E0%A4%A'), null)
      assert.strictEqual(decodePathSegment('%'), null)
      assert.strictEqual(decodePathSegment('%zz'), null)
    })

    test('a request through an http listener using the guard answers 400 and keeps serving', async () => {
      // The listener mirrors the /api/timeline/<id> route's shape: decode, 400 on null, else 200.
      const server = http.createServer((req, res) => {
        const id = decodePathSegment((req.url ?? '').slice('/api/timeline/'.length))
        if (id === null) { res.writeHead(400); res.end(); return }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id }))
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      const get = (p: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p }, res => {
          let body = ''
          res.on('data', c => { body += c })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }).on('error', reject)
      })
      try {
        const bad = await get('/api/timeline/%E0%A4%A')
        assert.strictEqual(bad.status, 400)
        const good = await get('/api/timeline/sess%2D1')
        assert.strictEqual(good.status, 200)
        assert.deepStrictEqual(JSON.parse(good.body), { id: 'sess-1' })
      } finally {
        server.close()
      }
    })
  })

  suite('redactTokenInUrl', () => {
    test('replaces the token value and nothing else', () => {
      assert.strictEqual(redactTokenInUrl('http://localhost:3000/?token=abc123'), `http://localhost:3000/?token=${REDACTED_TOKEN}`)
      assert.strictEqual(redactTokenInUrl('http://h:1/?a=1&token=abc123&b=2'), `http://h:1/?a=1&token=${REDACTED_TOKEN}&b=2`)
    })

    test('leaves a URL without a token alone', () => {
      assert.strictEqual(redactTokenInUrl('http://localhost:3000'), 'http://localhost:3000')
    })
  })

  suite('mayPrintFullUrl', () => {
    test('only in an interactive terminal that is not the background service', () => {
      assert.strictEqual(mayPrintFullUrl({ service: false, stdoutIsTty: true }), true)
      assert.strictEqual(mayPrintFullUrl({ service: true, stdoutIsTty: true }), false)
      assert.strictEqual(mayPrintFullUrl({ service: false, stdoutIsTty: false }), false)
      assert.strictEqual(mayPrintFullUrl({ service: true, stdoutIsTty: false }), false)
    })
  })
})
