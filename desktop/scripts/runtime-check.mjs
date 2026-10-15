/**
 * Prints the Node version bundled in the installed Electron, and fails if it is below the
 * collector's `engines.node` floor in the repo's package.json.
 *
 * This is the check desktop/README.md asks for on every Electron major: the collector runs on
 * Electron's binary re-entered as Node (`ELECTRON_RUN_AS_NODE=1`), so an Electron upgrade that
 * bundles an older Node than the collector requires is a broken app with a green type check.
 * `resources.ts` asserts the same thing at app startup; this catches it at build time, in CI, on
 * every platform the app targets.
 *
 * A script rather than an inline `ELECTRON_RUN_AS_NODE=1 electron -e …` because that env-prefix
 * syntax is POSIX only — on Windows cmd.exe it is not a command.
 *
 *   cd desktop && pnpm run runtime-check
 */

import { spawnSync } from 'child_process'
import * as fs from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Under plain Node, `require('electron')` resolves to the path of the Electron binary.
const electron = require('electron')
if (typeof electron !== 'string' || !fs.existsSync(electron)) {
  console.error(`runtime-check: the Electron binary is not installed (${String(electron)}). Run \`npm install\` in desktop/ — or, if node_modules/electron exists but dist/ does not, \`node node_modules/electron/install.js\`.`)
  process.exit(1)
}

const result = spawnSync(electron, ['-e', 'process.stdout.write(process.versions.node)'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf-8',
  windowsHide: true,
})
if (result.status !== 0 || !result.stdout) {
  console.error(`runtime-check: Electron did not run as Node (exit ${result.status ?? 'signal'}): ${result.stderr || ''}`)
  process.exit(1)
}
const bundled = result.stdout.trim()

const rootManifest = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf-8'))
const floor = String(rootManifest.engines?.node ?? '')
const required = Number(/>=\s*(\d+)/.exec(floor)?.[1])
const major = Number(bundled.split('.')[0])

if (!Number.isFinite(required)) {
  console.error(`runtime-check: could not read a ">=N" floor from engines.node (${JSON.stringify(floor)})`)
  process.exit(1)
}
console.log(`Electron ${require('electron/package.json').version} bundles Node ${bundled}; the collector requires Node ${floor}`)
if (!Number.isFinite(major) || major < required) {
  console.error('runtime-check: the bundled Node is too old for the collector. Do not ship this Electron.')
  process.exit(1)
}
