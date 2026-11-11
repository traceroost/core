/**
 * electron-builder `afterSign` hook: notarizes the signed macOS .app and staples the ticket to it,
 * before the builder wraps it in the DMG. electron-builder.cjs turns the builder's own
 * notarization off (`notarize: false`) and installs this hook instead when a Developer ID build
 * has notarization credentials; without them it is not installed and nothing here runs.
 *
 * It does what the builder's notarization does — the same credential sets read the same way
 * (app-builder-lib's `getNotarizeOptions`), the same signature check, the same notarytool submit
 * and wait (@electron/notarize, the copy the builder itself uses) — except the stapling, which
 * gets a much longer retry. `stapler staple` fetches the ticket from Apple's ticket service
 * (api.apple-cloudkit.com), and a runner's connection to it drops now and then ("The network
 * connection was lost", exit 68) with a perfectly good notarization behind it. @electron/notarize
 * retries for about seven seconds, and on 2026-11-04 an outage outlasted that and failed a CI
 * build that a rerun then passed. Here: six tries, thirty seconds apart. The submission is not
 * retried — a notarization that Apple rejected stays rejected, and notarytool waits out its own
 * network trouble.
 */

const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { Arch } = require('app-builder-lib')
const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper')

// @electron/notarize is app-builder-lib's dependency, not ours: resolved from there, so this is
// the version the builder would have run, wherever the package manager put it.
const notarizeDir = path.dirname(require.resolve('@electron/notarize/package.json', {
  paths: [path.dirname(require.resolve('app-builder-lib/package.json'))],
}))
const { checkSignatures } = require(path.join(notarizeDir, 'lib', 'check-signature'))
const { notarizeAndWaitForNotaryTool } = require(path.join(notarizeDir, 'lib', 'notarytool'))

const STAPLE_TRIES = 6
const STAPLE_DELAY_MS = 30_000

/** @param {import('app-builder-lib').AfterPackContext} context */
module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const options = MacTargetHelper.getNotarizeOptions(appPath)
  if (!options) throw new Error('afterSign: no notarization credentials in the environment (electron-builder.cjs installs this hook only when there are)')

  const started = Date.now()
  console.log(`  • afterSign: notarizing ${path.basename(appPath)} (${Arch[context.arch]}), usually a few minutes`)
  await checkSignatures({ appPath })
  await notarizeAndWaitForNotaryTool(options)
  console.log(`  • afterSign: notarization accepted after ${Math.round((Date.now() - started) / 1000)}s`)
  await staple(appPath)
}

async function staple(appPath) {
  for (let attempt = 1; ; attempt++) {
    try {
      await promisify(execFile)('xcrun', ['stapler', 'staple', '-v', appPath], { maxBuffer: 16 * 1024 * 1024 })
      console.log(`  • afterSign: ticket stapled${attempt > 1 ? ` (attempt ${attempt} of ${STAPLE_TRIES})` : ''}`)
      return
    } catch (error) {
      const output = `${error.stdout || ''}${error.stderr || ''}`.trim().split('\n').slice(-3).join(' / ')
      if (attempt >= STAPLE_TRIES) {
        throw new Error(`afterSign: stapling failed ${STAPLE_TRIES} times (exit ${error.code}): ${output}`)
      }
      console.log(`  • afterSign: stapling failed (attempt ${attempt} of ${STAPLE_TRIES}, exit ${error.code}), retrying in ${STAPLE_DELAY_MS / 1000}s: ${output}`)
      await new Promise(resolve => setTimeout(resolve, STAPLE_DELAY_MS))
    }
  }
}
