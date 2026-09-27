import * as assert from 'assert'
import { resolveOrgEnvironment, orgEndpoint } from '../../../cloud/org/config'

suite('org/config — resolveOrgEnvironment', () => {
  const savedUrl = process.env.TRACEROOST_ORG_URL
  const savedEnv = process.env.TRACEROOST_ORG_ENV

  teardown(() => {
    if (savedUrl === undefined) delete process.env.TRACEROOST_ORG_URL
    else process.env.TRACEROOST_ORG_URL = savedUrl
    if (savedEnv === undefined) delete process.env.TRACEROOST_ORG_ENV
    else process.env.TRACEROOST_ORG_ENV = savedEnv
  })

  test('TRACEROOST_ORG_URL wins outright, even over TRACEROOST_ORG_ENV', () => {
    process.env.TRACEROOST_ORG_URL = 'http://localhost:3000/'
    process.env.TRACEROOST_ORG_ENV = 'stage'
    const resolved = resolveOrgEnvironment()
    assert.strictEqual(resolved.endpoint, 'http://localhost:3000') // trailing slash stripped
    assert.strictEqual(resolved.environment, 'custom')
    assert.strictEqual(resolved.source, 'env-url')
  })

  test('TRACEROOST_ORG_URL matching a known environment is named, not "custom"', () => {
    process.env.TRACEROOST_ORG_URL = 'https://test.traceroost.com'
    delete process.env.TRACEROOST_ORG_ENV
    const resolved = resolveOrgEnvironment()
    assert.strictEqual(resolved.environment, 'test')
    assert.strictEqual(resolved.source, 'env-url')
  })

  test('TRACEROOST_ORG_ENV selects a named environment when no URL override is set', () => {
    delete process.env.TRACEROOST_ORG_URL
    process.env.TRACEROOST_ORG_ENV = 'STAGE' // case-insensitive
    const resolved = resolveOrgEnvironment()
    assert.strictEqual(resolved.endpoint, 'https://stage.traceroost.com')
    assert.strictEqual(resolved.environment, 'stage')
    assert.strictEqual(resolved.source, 'env-var')
  })

  test('an unrecognized TRACEROOST_ORG_ENV value falls through instead of throwing', () => {
    delete process.env.TRACEROOST_ORG_URL
    process.env.TRACEROOST_ORG_ENV = 'not-a-real-environment'
    const resolved = resolveOrgEnvironment()
    assert.notStrictEqual(resolved.source, 'env-var')
  })

  test('orgEndpoint() is a thin wrapper returning just the endpoint', () => {
    process.env.TRACEROOST_ORG_ENV = 'production'
    delete process.env.TRACEROOST_ORG_URL
    assert.strictEqual(orgEndpoint(), 'https://traceroost.com')
  })
})
