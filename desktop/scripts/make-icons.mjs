/**
 * Generates the desktop app's icon assets from `media/icon.svg`, the same glyph the extension and
 * the dashboard favicon use.
 *
 * macOS — the menu bar icons are *template* images: macOS ignores their colour and uses only their
 * alpha, recolouring them for a light or dark menu bar and for the highlighted state.
 * `media/icon.svg` is already a solid-black glyph on transparency, which is exactly the right
 * source — a coloured icon would be flattened to a silhouette anyway, and a near-white one would
 * come out invisible against a light menu bar. The `Template` suffix in the filename is what
 * Electron and AppKit key on, so it is load-bearing, not a naming convention.
 *
 * Windows — nothing recolours a tray icon for us, so there are two ICOs, one per taskbar
 * appearance: a white glyph for the (default) dark taskbar and the black glyph for a light one.
 * `tray.ts` picks by `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` and swaps on change.
 * Each ICO carries 16/20/24/32/40/48/64 px frames so the shell picks a crisp one at every DPI
 * scale from 100% to 400% instead of resampling a 16 px bitmap. Frames are PNG-compressed inside
 * the ICO container, which Windows has accepted since Vista. `icon.ico` is the app's own icon
 * (window, taskbar, Alt-Tab, and later the installer).
 *
 * The generated files *are* committed, even though they are derived: `sips` is macOS-only, so a
 * Linux or Windows CI runner could not produce them, and tray.ts needs them at run time.
 * `media/icon.svg` stays the source of truth — re-run this when that glyph changes:
 *
 *   node scripts/make-icons.mjs
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const source = path.join(desktopDir, '..', 'media', 'icon.svg')
const buildDir = path.join(desktopDir, 'build')

if (process.platform !== 'darwin') {
  console.error('make-icons: needs macOS (sips). The generated files are committed, so this only has to run when the source glyph changes.')
  process.exit(1)
}
if (!fs.existsSync(source)) throw new Error(`make-icons: ${source} is missing`)
fs.mkdirSync(buildDir, { recursive: true })

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-make-icons-'))

/** The same glyph in white, for a dark Windows taskbar. The SVG paints with `#000` fills and
 *  strokes and nothing else, so a colour swap is a text substitution. */
const whiteSource = path.join(scratch, 'icon-white.svg')
const svg = fs.readFileSync(source, 'utf-8')
if (!svg.includes('#000')) throw new Error('make-icons: expected media/icon.svg to paint with #000')
fs.writeFileSync(whiteSource, svg.replaceAll('#000', '#fff'))

function rasterize(svgPath, size, outPath) {
  execFileSync('sips', [
    '-s', 'format', 'png',
    '-z', String(size), String(size),
    svgPath, '--out', outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  return fs.readFileSync(outPath)
}

/** Packs PNG frames into one ICO: a 6-byte header, a 16-byte directory entry per frame, then the
 *  PNG bytes verbatim. Width/height bytes are 0 for 256 px, per the format. */
function writeIco(outPath, frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)             // reserved
  header.writeUInt16LE(1, 2)             // type: icon
  header.writeUInt16LE(frames.length, 4)
  const entries = []
  let offset = 6 + 16 * frames.length
  for (const { size, png } of frames) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)                   // palette: none
    e.writeUInt8(0, 3)                   // reserved
    e.writeUInt16LE(1, 4)                // colour planes
    e.writeUInt16LE(32, 6)               // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    entries.push(e)
  }
  fs.writeFileSync(outPath, Buffer.concat([header, ...entries, ...frames.map(f => f.png)]))
}

function report(name) {
  console.log(`${name.padEnd(28)} ${(fs.statSync(path.join(buildDir, name)).size / 1024).toFixed(1)} KB`)
}

// ── macOS: menu bar (1x/2x) and the app icon for the Dock and the About box ──
for (const { name, size } of [
  { name: 'trayTemplate.png', size: 16 },
  { name: 'trayTemplate@2x.png', size: 32 },
  { name: 'icon.png', size: 1024 },
]) {
  rasterize(source, size, path.join(buildDir, name))
  report(name)
}

// ── Windows: tray ICOs per taskbar appearance, and the app ICO ──
const TRAY_SIZES = [16, 20, 24, 32, 40, 48, 64]
const APP_SIZES = [16, 24, 32, 48, 64, 128, 256]
const frames = (svgPath, sizes) => sizes.map(size => ({ size, png: rasterize(svgPath, size, path.join(scratch, `${path.basename(svgPath, '.svg')}-${size}.png`)) }))

writeIco(path.join(buildDir, 'trayForDarkTaskbar.ico'), frames(whiteSource, TRAY_SIZES))
report('trayForDarkTaskbar.ico')
writeIco(path.join(buildDir, 'trayForLightTaskbar.ico'), frames(source, TRAY_SIZES))
report('trayForLightTaskbar.ico')
writeIco(path.join(buildDir, 'icon.ico'), frames(source, APP_SIZES))
report('icon.ico')

fs.rmSync(scratch, { recursive: true, force: true })
