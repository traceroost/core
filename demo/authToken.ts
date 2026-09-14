/**
 * Reads the bearer token a running standalone server generated at startup.
 *
 * Every request to the UI server is authenticated (see src/httpSecurity.ts) — unconditionally,
 * even on loopback, unlike the OTLP/MCP servers. Loading the dashboard at all means navigating
 * with `?token=<value>`, exactly as the URL the server prints at startup does. The token is
 * generated once and persisted to `<HOME>/.traceroost/config.json`'s `authToken` field
 * (`ensureAuthToken` in src/serviceConfig.ts) — pass whatever `HOME` the target server process
 * actually started with, which matters when it's been overridden (a scratch environment).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export function readAuthToken(home: string): string | null {
  const configPath = path.join(home, '.traceroost', 'config.json')
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { authToken?: string }
    return raw.authToken || null
  } catch {
    return null
  }
}

/** Polls for the token — `ensureAuthToken` runs before the server starts listening, so by the
 *  time a health check succeeds the file should already exist; this is a small safety margin,
 *  not the primary wait. */
export async function waitForAuthToken(home: string, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const token = readAuthToken(home)
    if (token) return token
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}
