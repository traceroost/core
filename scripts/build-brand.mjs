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

const read = (p) => readFileSync(join(brand, p), 'utf8')
const write = (p, s) => { writeFileSync(join(brand, p), s.trimEnd() + '\n'); console.log('  media/brand/' + p) }

// Recolour only glyph/mark <path> fills, leaving <rect> accents (the roost bar) intact.
const recolorPaths = (svg, from, to) =>
  svg.replace(new RegExp(`(<path[^>]*?fill=")${from}(")`, 'g'), `$1${to}$2`)

console.log('brand SVGs:')

const wordmark = read('wordmark.svg')
// Light text -> paper text, for dark backgrounds.
write('wordmark-on-dark.svg', wordmark.split(INK).join(PAPER))
// Single-ink typography (roost stops being teal); the roost bar stays teal.
write('wordmark-mono.svg', recolorPaths(wordmark, TEAL, INK))

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
// marketplace frames it), dark background, paper mark.
const marketplace = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
  `<rect width="512" height="512" fill="${NIGHT}"/>` +
  `<g transform="translate(71.4,77.9) scale(0.19232)">` +
  markSmallBody.replace(/fill="[^"]*"/g, `fill="${PAPER}"`).replace(/stroke="[^"]*"/g, `stroke="${PAPER}"`) +
  `</g></svg>`

console.log('raster:')
await sharp(Buffer.from(marketplace)).png().toFile(join(media, 'mascot.png'))
console.log('  media/mascot.png (512, marketplace)')

// Standalone favicon.
writeFileSync(join(media, 'favicon.svg'), iconAt(NIGHT, PAPER) + '\n')
console.log('  media/favicon.svg')
