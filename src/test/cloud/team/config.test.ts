import * as assert from 'assert'
import { resolveTeamEnvironment, teamEndpoint } from '../../../cloud/team/config'

suite('team/config — resolveTeamEnvironment', () => {
  const savedUrl = process.env.TRACEROOST_TEAM_URL
  const savedEnv = process.env.TRACEROOST_TEAM_ENV

  teardown(() => {
    if (savedUrl === undefined) delete process.env.TRACEROOST_TEAM_URL
    else process.env.TRACEROOST_TEAM_URL = savedUrl
    if (savedEnv === undefined) delete process.env.TRACEROOST_TEAM_ENV
    else process.env.TRACEROOST_TEAM_ENV = savedEnv
  })

  test('TRACEROOST_TEAM_URL wins outright, even over TRACEROOST_TEAM_ENV', () => {
    process.env.TRACEROOST_TEAM_URL = 'http://localhost:3000/'
    process.env.TRACEROOST_TEAM_ENV = 'stage'
    const resolved = resolveTeamEnvironment()
    assert.strictEqual(resolved.endpoint, 'http://localhost:3000') // trailing slash stripped
    assert.strictEqual(resolved.environment, 'custom')
    assert.strictEqual(resolved.source, 'env-url')
  })

  test('TRACEROOST_TEAM_URL matching a known environment is named, not "custom"', () => {
    process.env.TRACEROOST_TEAM_URL = 'https://test.traceroost.com'
    delete process.env.TRACEROOST_TEAM_ENV
    const resolved = resolveTeamEnvironment()
    assert.strictEqual(resolved.environment, 'test')
    assert.strictEqual(resolved.source, 'env-url')
  })

  test('TRACEROOST_TEAM_ENV selects a named environment when no URL override is set', () => {
    delete process.env.TRACEROOST_TEAM_URL
    process.env.TRACEROOST_TEAM_ENV = 'STAGE' // case-insensitive
    const resolved = resolveTeamEnvironment()
    assert.strictEqual(resolved.endpoint, 'https://stage.traceroost.com')
    assert.strictEqual(resolved.environment, 'stage')
    assert.strictEqual(resolved.source, 'env-var')
  })

  test('an unrecognized TRACEROOST_TEAM_ENV value falls through instead of throwing', () => {
    delete process.env.TRACEROOST_TEAM_URL
    process.env.TRACEROOST_TEAM_ENV = 'not-a-real-environment'
    const resolved = resolveTeamEnvironment()
    assert.notStrictEqual(resolved.source, 'env-var')
  })

  test('teamEndpoint() is a thin wrapper returning just the endpoint', () => {
    process.env.TRACEROOST_TEAM_ENV = 'production'
    delete process.env.TRACEROOST_TEAM_URL
    assert.strictEqual(teamEndpoint(), 'https://traceroost.com')
  })
})
