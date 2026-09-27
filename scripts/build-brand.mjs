// Regenerates derived brand assets from the canonical sources in media/brand/.
//
//   node scripts/build-brand.mjs
//
// Canonical (hand-maintained) sources:
//   media/brand/wordmark.svg      full lockup, light background
//   media/brand/mark.svg          mark only (bird + roost bar + ground lines)
//   media/brand/mark-small.svg    simplified mark for small sizes
//   media/brand/mark-perch.svg    mark on the roost bar, no ground lines
//
// Everything below is derived from those and should not be hand-edited.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const brand = join(root, 'media', 'brand')
const media = join(root, 'media')

const INK = '#12141A'       // near-black brand ink
const PAPER = '#E8ECEF'     // off-white, used as ink on dark
const TEAL = '#0FBFA6'      // roost accent
const NIGHT = '#0B0D12'     // icon dark background
// Neutral mid-grey — a deliberate compromise for the one spot (README, rendered on both a
// white npm/GitHub-light page and the VS Code Marketplace's dark theme by whichever picks
// the <img> fallback) that can't pick a background to design against. Chosen so contrast
// against pure white and against NIGHT comes out roughly balanced — passable on both,
// ideal on neither.
const MID = '#76797F'

const read = (p) => readFileSync(join(brand, p), 'utf8')
const write = (p, s) => { writeFileSync(join(brand, p), s.trimEnd() + '\n'); console.log('  media/brand/' + p) }

// Recolour only glyph/mark <path> fills, leaving <rect> accents (the roost bar) intact.
const recolorPaths = (svg, from, to) =>
  svg.replace(new RegExp(`(<path[^>]*?fill=")${from}(")`, 'g'), `$1${to}$2`)

console.log('brand SVGs:')

const wordmark = read('wordmark.svg')
// Light text -> paper text, for dark backgrounds.
write('wordmark-on-dark.svg', wordmark.split(INK).join(PAPER))
// Mid-grey text/bird, roost bar stays teal — the "works passably anywhere" compromise.
write('wordmark-mid.svg', wordmark.split(INK).join(MID))
// Single-ink typography (roost stops being teal); the roost bar stays teal.
write('wordmark-mono.svg', recolorPaths(wordmark, TEAL, INK))
// Theme-adaptive: mark + ground + "trace" inherit currentColor, the roost bar
// and "roost" keep the teal.
write('wordmark-currentcolor.svg', wordmark.split(INK).join('currentColor'))

// Text-only lockup (no bird), lifted from the letters group of wordmark.svg.
// Used inline in the dashboard header (Wordmark.tsx).
const letters = wordmark.match(/<g transform="translate\(99\.4,0\)">[\s\S]*?<\/g><\/g>/)[0]
const textSvg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -1 214 34">` +
  `<g transform="translate(-99.4,-25.5)">${body}</g></svg>`
write('wordmark-text.svg', textSvg(letters))
write('wordmark-text-currentcolor.svg', textSvg(letters.split(INK).join('currentColor')))

const mark = read('mark.svg')
write('mark-on-dark.svg', mark.split(INK).join(PAPER))
write('mark-mono.svg', mark.split(TEAL).join(INK))
// Theme-adaptive: bird + ground inherit the host text colour, roost bar stays
// teal. Used inline in the webview so one asset works in every VS Code theme
// and in the standalone light/dark modes.
write('mark-currentcolor.svg', mark.split(INK).join('currentColor'))

// App icons: rounded-square lockups at 128, mark centred via mark-small.
const markSmallBody = read('mark-small.svg')
  .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
const iconAt = (bg, ink) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
  `<rect width="128" height="128" rx="22" fill="${bg}"/>` +
  `<g transform="translate(17.85,19.48) scale(0.04808)">` +
  markSmallBody.replace(/fill="[^"]*"/g, `fill="${ink}"`).replace(/stroke="[^"]*"/g, `stroke="${ink}"`) +
  `</g></svg>`
write('icon-dark.svg', iconAt(NIGHT, PAPER))
write('icon-light.svg', iconAt('#FFFFFF', INK))
write('icon-teal.svg', iconAt(TEAL, NIGHT))

// VS Code activity-bar icon: single-colour, transparent, 256x256 (matches the
// size of the file it replaces). VS Code applies the theme colour itself.
const activityBar = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
  `<g transform="translate(35.7,38.96) scale(0.09616)">` +
  markSmallBody.replace(/fill="[^"]*"/g, 'fill="#000"').replace(/stroke="[^"]*"/g, 'stroke="#000"') +
  `</g></svg>`
writeFileSync(join(media, 'icon.svg'), activityBar + '\n')
console.log('  media/icon.svg (activity bar, mono 256)')

// Raster: marketplace icon. Full-bleed square (no rounded corners — the
// marketplace frames it), teal background (the brand accent, not just a thin
// roost-bar sliver), ink mark — this is the browser tab favicon.
const marketplace = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
  `<rect width="512" height="512" fill="${TEAL}"/>` +
  `<g transform="translate(71.4,77.9) scale(0.19232)">` +
  markSmallBody.replace(/fill="[^"]*"/g, `fill="${NIGHT}"`).replace(/stroke="[^"]*"/g, `stroke="${NIGHT}"`) +
  `</g></svg>`

console.log('raster:')
await sharp(Buffer.from(marketplace)).png().toFile(join(media, 'mascot.png'))
console.log('  media/mascot.png (512, marketplace)')

// Raster: marketplace icon, color variant. Same teal background as the mono one above, but
// keeps mark-small.svg's two-tone read (ink bird, now a paper roost bar so it still reads
// against teal) instead of collapsing to one ink — this is what package.json's "icon" (the
// extension listing's actual icon, shown in-browser on the Marketplace/Open VSX pages) points
// at; mascot.png above stays as-is for the standalone server favicon.
const marketplaceColor = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
  `<rect width="512" height="512" fill="${TEAL}"/>` +
  `<g transform="translate(71.4,77.9) scale(0.19232)">` +
  markSmallBody.replace(/fill="#0FBFA6"/, `fill="${PAPER}"`) +
  `</g></svg>`
await sharp(Buffer.from(marketplaceColor)).png().toFile(join(media, 'mascot-color.png'))
console.log('  media/mascot-color.png (512, marketplace, color)')

// README hero wordmark. The VS Code Marketplace/Open VSX packager (vsce) rejects README
// images referencing SVG (a marketplace-wide policy, not something this project can opt out
// of), so the light/dark wordmark used at the top of README.md has to be a raster — 3x the
// 321x97 viewBox for retina sharpness at the ~40px display height, transparent background.
const wordmarkPngWidth = 963
const wordmarkPngHeight = Math.round(wordmarkPngWidth * (97 / 321))
await sharp(Buffer.from(wordmark)).resize(wordmarkPngWidth, wordmarkPngHeight).png().toFile(join(brand, 'wordmark.png'))
console.log('  media/brand/wordmark.png (README hero, light)')
const wordmarkOnDark = read('wordmark-on-dark.svg')
await sharp(Buffer.from(wordmarkOnDark)).resize(wordmarkPngWidth, wordmarkPngHeight).png().toFile(join(brand, 'wordmark-on-dark.png'))
console.log('  media/brand/wordmark-on-dark.png (README hero, dark)')
const wordmarkMid = read('wordmark-mid.svg')
await sharp(Buffer.from(wordmarkMid)).resize(wordmarkPngWidth, wordmarkPngHeight).png().toFile(join(brand, 'wordmark-mid.png'))
console.log('  media/brand/wordmark-mid.png (README hero, mid-grey compromise)')

// Standalone favicon.
writeFileSync(join(media, 'favicon.svg'), iconAt(TEAL, NIGHT) + '\n')
console.log('  media/favicon.svg')
