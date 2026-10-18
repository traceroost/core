/**
 * Generates the desktop app's icon assets from `media/icon.svg`, the same glyph the extension and
 * the dashboard favicon use.
 *
 * The menu bar icons are *template* images: macOS ignores their colour and uses only their alpha,
 * recolouring them for a light or dark menu bar and for the highlighted state. `media/icon.svg` is
 * already a solid-black glyph on transparency, which is exactly the right source — a coloured icon
 * would be flattened to a silhouette anyway, and a near-white one would come out invisible against
 * a light menu bar. The `Template` suffix in the filename is what Electron and AppKit key on, so
 * it is load-bearing, not a naming convention.
 *
 * The generated PNGs *are* committed, even though they are derived: `sips` is macOS-only, so a
 * Linux CI runner cross-building the app could not produce them, and tray.ts needs them at run
 * time. `media/icon.svg` stays the source of truth — re-run this when that glyph changes:
 *
 *   node scripts/make-icons.mjs
 *
 * Windows: `build/icon.ico` (the app, installer and uninstaller icon, 16…256) and
 * `build/trayWindows.ico` (the notification-area icon, 16…64) are assembled from the tile PNGs
 * above. That step needs no macOS — it runs on any OS, and alone with `--ico` — so the .ico files
 * can never drift from the PNGs they are made of. Frames below 256 px are stored as 32-bit
 * BMP (DIB) images, which every Windows icon consumer reads, NSIS's installer icon included; the
 * 256 px frame is PNG, as Windows Vista and later expect.
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { createRequire } from 'module'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const glyph = path.join(desktopDir, '..', 'media', 'icon.svg')
// The favicon: the same glyph on the brand's teal tile. Linux panels are dark on some desktops and
// light on others and recolour nothing, so the Linux tray and app icons need their own contrast.
const tile = path.join(desktopDir, '..', 'media', 'favicon.svg')
const buildDir = path.join(desktopDir, 'build')

const icoOnly = process.argv.includes('--ico')
if (!icoOnly && process.platform !== 'darwin') {
  console.error('make-icons: the PNGs need macOS (sips). They are committed, so this only has to run when the source glyph changes; `--ico` rebuilds just the Windows .ico files from them, on any OS.')
  process.exit(1)
}
for (const source of [glyph, tile]) {
  if (!fs.existsSync(source)) throw new Error(`make-icons: ${source} is missing`)
}
fs.mkdirSync(path.join(buildDir, 'icons'), { recursive: true })

/** Menu bar, then the app icon for the Dock and the About box. 16/32 is the 1x/2x menu bar pair.
 *  Then Linux: the tray icon (StatusNotifierItem hosts draw it at 16–24 px and scale down, so a
 *  32/64 pair stays crisp on HiDPI panels), and the app icon electron-builder turns into the
 *  hicolor set for the .deb and AppImage and that the window uses at run time. */
const TARGETS = [
  { name: 'trayTemplate.png', size: 16, source: glyph },
  { name: 'trayTemplate@2x.png', size: 32, source: glyph },
  { name: 'icon.png', size: 1024, source: glyph },
  { name: 'trayLinux.png', size: 32, source: tile },
  { name: 'trayLinux@2x.png', size: 64, source: tile },
  // The hicolor theme's standard sizes, as electron-builder wants them for a Linux icon directory.
  ...[16, 24, 32, 48, 64, 128, 256, 512].map(size => ({ name: `icons/${size}x${size}.png`, size, source: tile })),
]

for (const { name, size, source } of icoOnly ? [] : TARGETS) {
  const out = path.join(buildDir, name)
  execFileSync('sips', [
    '-s', 'format', 'png',
    '-z', String(size), String(size),
    source, '--out', out,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`${name}  ${size}×${size}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`)
}

// ── Windows .ico, from the tile PNGs above ──

const ICONS = [
  { name: 'icon.ico', sizes: [16, 24, 32, 48, 64, 128, 256] },
  { name: 'trayWindows.ico', sizes: [16, 24, 32, 48, 64] },
]
// sharp decodes the PNGs; it is a devDependency of the repo root (desktop/ has no runtime deps).
const sharp = createRequire(path.join(desktopDir, '..', 'package.json'))('sharp')

for (const { name, sizes } of ICONS) {
  const frames = []
  for (const size of sizes) {
    const png = fs.readFileSync(path.join(buildDir, 'icons', `${size}x${size}.png`))
    if (size >= 256) { frames.push({ size, data: png }); continue }
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (info.width !== size || info.height !== size || info.channels !== 4) throw new Error(`make-icons: icons/${size}x${size}.png is ${info.width}×${info.height}×${info.channels}`)
    frames.push({ size, data: dib(data, size) })
  }
  const out = path.join(buildDir, name)
  fs.writeFileSync(out, ico(frames))
  console.log(`${name}  ${sizes.join('/')}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`)
}

/** A 32-bit BGRA device-independent bitmap as an icon frame: header, bottom-up pixels, AND mask. */
function dib(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight: XOR image + AND mask
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  // The alpha channel carries transparency; the 1-bit mask is all zeros (rows padded to 4 bytes).
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, mask])
}

/** ICONDIR + one ICONDIRENTRY per frame, then the frames. */
function ico(frames) {
  const head = Buffer.alloc(6 + 16 * frames.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(frames.length, 4)
  let offset = head.length
  frames.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, at) // 0 means 256
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4) // planes
    head.writeUInt16LE(32, at + 6) // bits per pixel
    head.writeUInt32LE(data.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...frames.map(f => f.data)])
}
