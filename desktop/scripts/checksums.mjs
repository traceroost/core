/**
 * Writes `dist/SHA256SUMS` for the packaged artifacts, in the format `shasum -a 256 -c` verifies:
 *
 *   cd dist && shasum -a 256 -c SHA256SUMS
 *
 * Covers every DMG and zip in dist/ (one of each per architecture). Run after `electron-builder`;
 * `pnpm run pack` does.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const artifacts = fs.existsSync(dist)
  ? fs.readdirSync(dist).filter(f => /^TraceRoost-.*\.(dmg|zip)$/.test(f)).sort()
  : []
if (artifacts.length === 0) {
  throw new Error(`checksums: no TraceRoost-*.dmg / .zip in ${dist} — run electron-builder first`)
}

const lines = artifacts.map(name => {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex')
  return `${hash}  ${name}`
})
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
console.log(`wrote ${path.relative(process.cwd(), path.join(dist, 'SHA256SUMS'))}`)
