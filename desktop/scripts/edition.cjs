/**
 * Which edition of TraceRoost the desktop app is being built as — `core` (no TraceRoost Cloud code)
 * or `full` (the collector carries the Cloud connector: org link + upload, the dashboard's Org
 * panel). It follows the release edition the way the VSIX, the npm package and the Docker image do:
 * release.yml → desktop-release.yml → desktop-{macos,linux,windows}.yml set
 * `TRACEROOST_DESKTOP_EDITION`, and every build step reads it here — stage-resources.mjs (which
 * collector it builds and checks), third-party-notices.mjs, electron-builder.cjs (the license files
 * that ship), afterPack.cjs (which edition check the packed collector must pass) and
 * smoke-packaged.mjs. Unset means `core`, so a pull request and a local build are unchanged.
 *
 * The main-process bundle (esbuild.mjs → out/main.js) is the same in both editions: the shell itself
 * never carries Cloud code — linking lives in the collector it spawns — and afterPack checks it
 * against the core marker list either way.
 */

const EDITIONS = ['core', 'full']

/** @returns {'core' | 'full'} */
function desktopEdition(env = process.env) {
  const raw = (env.TRACEROOST_DESKTOP_EDITION ?? '').trim()
  const edition = raw === '' ? 'core' : raw
  if (!EDITIONS.includes(edition)) {
    throw new Error(`TRACEROOST_DESKTOP_EDITION is "${raw}"; expected core or full`)
  }
  return /** @type {'core' | 'full'} */ (edition)
}

/** Written by stage-resources.mjs beside (not inside) the staged collector and read by
 *  afterPack.cjs, so a tree staged as one edition can't be packed as the other. Never shipped. */
const EDITION_STAMP = 'collector.edition'

module.exports = { desktopEdition, EDITION_STAMP }
