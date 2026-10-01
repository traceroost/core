/**
 * Extension-host entry point for the integration suites in this directory — loaded by VS Code via
 * `--extensionTestsPath` from tests/e2e/vscode/run.mjs (not by `pnpm test` / `test:unit`: the
 * suites here are `*.itest.ts`, which neither .vscode-test.mjs's nor .mocharc.cjs's globs match).
 *
 * TRACEROOST_IT_SUITES (comma-separated basenames, e.g. `extension,realAgents`) picks which
 * `<name>.itest.js` files run; the default is `extension`.
 */
import * as fs from 'fs'
import * as path from 'path'
import Mocha = require('mocha')

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10 * 60_000, bail: false })
  const wanted = (process.env.TRACEROOST_IT_SUITES || 'extension').split(',').map(s => s.trim()).filter(Boolean)
  for (const name of wanted) {
    const file = path.join(__dirname, `${name}.itest.js`)
    if (!fs.existsSync(file)) throw new Error(`no integration suite ${file}`)
    mocha.addFile(file)
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run(failures => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()))
  })
}
