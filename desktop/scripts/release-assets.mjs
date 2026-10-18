/**
 * Assembles the desktop files a `v*` release attaches to its GitHub release, from the build
 * artifacts the desktop workflows uploaded (.github/workflows/desktop-release.yml runs it):
 *
 *   node desktop/scripts/release-assets.mjs --in <downloaded artifacts> --out <dir> --version <v> --platforms linux,macos
 *
 * `--in` holds one directory per artifact (traceroost-desktop-macos, traceroost-desktop-linux-x64,
 * …), each with its installers and the SHA256SUMS its build wrote. For every SHA256SUMS found, each
 * listed file is re-hashed, so what is attached is byte-for-byte what was built and tested. For
 * each platform in `--platforms`, the exact set of installers for `--version` must be present (both
 * architectures, every format), and nothing with another version may sneak in: a missing or extra
 * file fails the release rather than publishing half of a platform.
 *
 * The workflow decides `--platforms`: a platform whose build failed, that is switched off, or (macOS)
 * that is not notarized is left out. Files of a left-out platform that are present are still
 * verified, then not attached.
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
    macos: ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `TraceRoost-${version}-mac-${arch}.${ext}`)),
    linux: [
      `TraceRoost-${version}-linux-amd64.deb`,
      `TraceRoost-${version}-linux-arm64.deb`,
      `TraceRoost-${version}-linux-x86_64.AppImage`,
      `TraceRoost-${version}-linux-arm64.AppImage`,
    ],
  }
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
 * Verifies and copies the release files; returns `{ attached, skipped }` (names). Throws on any
 * checksum mismatch, missing installer, unexpected installer, or the same name in two artifacts.
 */
export function assemble({ inDir, outDir, version, platforms }) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`release-assets: --version must be a semver version, got ${JSON.stringify(version)}`)
  }
  const expected = expectedAssets(version)
  const unknown = platforms.filter(p => !(p in expected))
  if (unknown.length > 0) throw new Error(`release-assets: unknown platform ${unknown.join(', ')} (known: ${Object.keys(expected).join(', ')})`)
  if (platforms.length === 0) throw new Error('release-assets: --platforms names no platform — nothing to attach')
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
  const wanted = platforms.flatMap(p => expected[p])
  const missing = wanted.filter(name => !verified.has(name))
  if (missing.length > 0) throw new Error(`release-assets: missing from the build artifacts: ${missing.join(', ')}`)

  fs.mkdirSync(outDir, { recursive: true })
  const attached = [...wanted].sort()
  for (const name of attached) fs.copyFileSync(verified.get(name).file, path.join(outDir, name))
  fs.writeFileSync(
    path.join(outDir, checksumsName(version)),
    attached.map(name => `${verified.get(name).hash}  ${name}`).join('\n') + '\n',
  )
  const skipped = [...verified.keys()].filter(name => !wanted.includes(name)).sort()
  return { attached, skipped }
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
    const { attached, skipped } = assemble(args)
    console.log(`attaching ${attached.length} files + ${checksumsName(args.version)}:`)
    for (const name of attached) console.log(`  ${name}`)
    if (skipped.length > 0) console.log(`verified but not attached (platform not released): ${skipped.join(', ')}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
