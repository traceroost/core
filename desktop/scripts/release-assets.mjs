/**
 * Assembles the desktop files a `v*` release attaches to its GitHub release, from the build
 * artifacts the desktop workflows uploaded (.github/workflows/desktop-release.yml runs it):
 *
 *   node desktop/scripts/release-assets.mjs --in <downloaded artifacts> --out <dir> --version <v> --platforms linux,macos,windows
 *
 * `--in` holds one directory per artifact (traceroost-desktop-macos, traceroost-desktop-linux-x64,
 * …), each with its installers and the SHA256SUMS its build wrote. For every SHA256SUMS found, each
 * listed file is re-hashed, so what is attached is byte-for-byte what was built and tested. For
 * each platform in `--platforms`, the exact set of installers for `--version` must be present (both
 * architectures, every format), and nothing with another version may sneak in: a missing or extra
 * file fails the release rather than publishing half of a platform.
 *
 * The workflow decides `--platforms`: a platform whose build failed, that is switched off, or that is
 * not signed (macOS: notarized; Windows: Authenticode) is left out. Files of a left-out platform that
 * are present are still verified, then not attached.
 *
 * `macos-preview` and `windows-preview` attach a build that is not yet signed (the workflow does
 * this whenever a macOS build is not notarized or a Windows build is not Authenticode-signed): the
 * same verified files, attached under a name that says so — `TraceRoost-<v>-mac-arm64-preview.dmg`,
 * `TraceRoost-<v>-win-x64-preview.exe` — so a preview download is never mistaken for a signed one,
 * and a later signed build of the same version never collides with it. A platform is attached
 * signed or as a preview, never both.
 *
 * `--out` gets the installers plus one `TraceRoost-desktop-<v>-SHA256SUMS` covering exactly the
 * files attached — the file users check with `sha256sum -c` and the one minisign signs.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

/** Every installer a release of `version` ships, by platform. Mirrors electron-builder.cjs's artifactName. */
export function expectedAssets(version) {
  return {
    macos: ['arm64', 'x64'].map(arch => `TraceRoost-${version}-mac-${arch}.dmg`),
    linux: [
      `TraceRoost-${version}-linux-amd64.deb`,
      `TraceRoost-${version}-linux-arm64.deb`,
      `TraceRoost-${version}-linux-x86_64.AppImage`,
      `TraceRoost-${version}-linux-arm64.AppImage`,
    ],
    // The NSIS installer.
    windows: ['x64', 'arm64'].map(arch => `TraceRoost-${version}-win-${arch}.exe`),
  }
}

/** Platforms whose builds need signing, and so may be attached unsigned as `<platform>-preview`. */
export const PREVIEW_PLATFORMS = ['macos', 'windows']
const PREVIEW = '-preview'

/** The name a preview (not yet signed) build is attached under: `-preview` before the extension. */
export function previewName(name) {
  const dot = name.lastIndexOf('.')
  return `${name.slice(0, dot)}${PREVIEW}${name.slice(dot)}`
}

export function checksumsName(version) {
  return `TraceRoost-desktop-${version}-SHA256SUMS`
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function findChecksumFiles(dir) {
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...findChecksumFiles(full))
    else if (entry.name === 'SHA256SUMS') found.push(full)
  }
  return found
}

/**
 * Verifies and copies the release files; returns `{ attached, skipped, preview }` (names). Throws on any
 * checksum mismatch, missing installer, unexpected installer, or the same name in two artifacts.
 */
export function assemble({ inDir, outDir, version, platforms }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`release-assets: --version must be a semver version, got ${JSON.stringify(version)}`)
  }
  const expected = expectedAssets(version)
  const knownPlatforms = [...Object.keys(expected), ...PREVIEW_PLATFORMS.map(p => `${p}${PREVIEW}`)]
  const unknown = platforms.filter(p => !knownPlatforms.includes(p))
  if (unknown.length > 0) throw new Error(`release-assets: unknown platform ${unknown.join(', ')} (known: ${knownPlatforms.join(', ')})`)
  if (platforms.length === 0) throw new Error('release-assets: --platforms names no platform — nothing to attach')
  const both = PREVIEW_PLATFORMS.filter(p => platforms.includes(p) && platforms.includes(`${p}${PREVIEW}`))
  if (both.length > 0) throw new Error(`release-assets: ${both.join(', ')} named both signed and preview — a platform is attached one way or the other`)
  const sums = findChecksumFiles(inDir)
  if (sums.length === 0) throw new Error(`release-assets: no SHA256SUMS under ${inDir}`)

  /** name → { file, hash } */
  const verified = new Map()
  for (const sumsFile of sums) {
    const dir = path.dirname(sumsFile)
    for (const line of fs.readFileSync(sumsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
      if (!match) throw new Error(`release-assets: unreadable line in ${sumsFile}: ${JSON.stringify(line)}`)
      const [, hash, name] = match
      if (name !== path.basename(name)) throw new Error(`release-assets: ${sumsFile} lists a path, not a file name: ${name}`)
      const file = path.join(dir, name)
      if (!fs.existsSync(file)) throw new Error(`release-assets: ${sumsFile} lists ${name}, which is not in the artifact`)
      const actual = sha256(file)
      if (actual !== hash) throw new Error(`release-assets: ${name} does not match its checksum (${actual} != ${hash})`)
      if (verified.has(name)) throw new Error(`release-assets: ${name} appears in two artifacts`)
      verified.set(name, { file, hash })
    }
  }

  const known = new Set(Object.values(expected).flat())
  const unexpected = [...verified.keys()].filter(name => !known.has(name))
  if (unexpected.length > 0) {
    throw new Error(`release-assets: unexpected files for ${version}: ${unexpected.join(', ')} (is package.json's version the tag's?)`)
  }
  /** source name (as built) → name attached */
  const wanted = new Map(platforms.flatMap(p => p.endsWith(PREVIEW)
    ? expected[p.slice(0, -PREVIEW.length)].map(name => [name, previewName(name)])
    : expected[p].map(name => [name, name])))
  const missing = [...wanted.keys()].filter(name => !verified.has(name))
  if (missing.length > 0) throw new Error(`release-assets: missing from the build artifacts: ${missing.join(', ')}`)

  fs.mkdirSync(outDir, { recursive: true })
  const bySource = [...wanted].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  for (const [source, as] of bySource) fs.copyFileSync(verified.get(source).file, path.join(outDir, as))
  fs.writeFileSync(
    path.join(outDir, checksumsName(version)),
    bySource.map(([source, as]) => `${verified.get(source).hash}  ${as}`).join('\n') + '\n',
  )
  const attached = bySource.map(([, as]) => as)
  const preview = bySource.filter(([source, as]) => source !== as).map(([, as]) => as)
  const skipped = [...verified.keys()].filter(name => !wanted.has(name)).sort()
  return { attached, skipped, preview }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--platforms') args.platforms = (argv[++i] ?? '').split(',').map(p => p.trim()).filter(Boolean)
    else if (flag === '--in') args.inDir = argv[++i]
    else if (flag === '--out') args.outDir = argv[++i]
    else if (flag === '--version') args.version = argv[++i]
    else throw new Error(`release-assets: unknown argument ${flag}`)
  }
  if (!args.inDir || !args.outDir || !args.platforms) throw new Error('release-assets: --in, --out and --platforms are required')
  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const { attached, skipped, preview } = assemble(args)
    console.log(`attaching ${attached.length} files + ${checksumsName(args.version)}:`)
    for (const name of attached) console.log(`  ${name}${preview.includes(name) ? '   (preview)' : ''}`)
    if (skipped.length > 0) console.log(`verified but not attached (platform not released): ${skipped.join(', ')}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
