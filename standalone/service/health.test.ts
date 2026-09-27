import * as assert from 'assert'
import { healthProbeUrl } from './health'

suite('healthProbeUrl', () => {
  test('uses an IPv4 or hostname bind host as-is', () => {
    assert.strictEqual(healthProbeUrl(3000, '127.0.0.1'), 'http://127.0.0.1:3000/health')
    assert.strictEqual(healthProbeUrl(3001, 'localhost'), 'http://localhost:3001/health')
  })

  test('maps wildcard binds to loopback', () => {
    assert.strictEqual(healthProbeUrl(3000, '0.0.0.0'), 'http://127.0.0.1:3000/health')
    assert.strictEqual(healthProbeUrl(3000, ''), 'http://127.0.0.1:3000/health')
    assert.strictEqual(healthProbeUrl(3000, '::'), 'http://[::1]:3000/health')
    assert.strictEqual(healthProbeUrl(3000, '[::]'), 'http://[::1]:3000/health')
    assert.strictEqual(healthProbeUrl(3000, '0:0:0:0:0:0:0:0'), 'http://[::1]:3000/health')
  })

  test('brackets IPv6 literals so the URL parses', () => {
    assert.strictEqual(healthProbeUrl(3000, '::1'), 'http://[::1]:3000/health')
    assert.strictEqual(healthProbeUrl(3000, '[fe80::1]'), 'http://[fe80::1]:3000/health')
    assert.strictEqual(new URL(healthProbeUrl(3000, '2001:db8::5')).hostname, '[2001:db8::5]')
  })
})
