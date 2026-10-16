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
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const glyph = path.join(desktopDir, '..', 'media', 'icon.svg')
// The favicon: the same glyph on the brand's teal tile. Linux panels are dark on some desktops and
// light on others and recolour nothing, so the Linux tray and app icons need their own contrast.
const tile = path.join(desktopDir, '..', 'media', 'favicon.svg')
const buildDir = path.join(desktopDir, 'build')

if (process.platform !== 'darwin') {
  console.error('make-icons: needs macOS (sips). The generated PNGs are committed, so this only has to run when the source glyph changes.')
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

for (const { name, size, source } of TARGETS) {
  const out = path.join(buildDir, name)
  execFileSync('sips', [
    '-s', 'format', 'png',
    '-z', String(size), String(size),
    source, '--out', out,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`${name}  ${size}×${size}  ${(fs.statSync(out).size / 1024).toFixed(1)} KB`)
}
