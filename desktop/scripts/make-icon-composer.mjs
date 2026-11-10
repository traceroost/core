/**
 * Writes the macOS 26 app icon, `build/icon.icon` (an Icon Composer document), from
 * `media/favicon.svg` — the same bird on the same teal tile as `build/icon.icns`.
 *
 * Why it exists: macOS 26 restyles an app that ships only an `.icns` whenever System Settings →
 * Appearance → Icon & widget style is Dark, Clear or Tinted — it guessed a black tile with a grey
 * bird for TraceRoost. An Icon Composer icon says what each appearance looks like instead:
 *
 *   light (and the base every appearance inherits)  teal fill, near-black bird — today's tile
 *   dark                                            near-black fill, teal bird
 *   tinted                                          left to macOS, from the base
 *
 * electron-builder (mac.icon in electron-builder.cjs) compiles it with Xcode 26's `actool` into
 * the app's `Assets.car` (CFBundleIconName) plus the `icon.icns` older macOS and the DMG use, so a
 * macOS build now needs Xcode 26 (the macOS CI jobs run on macos-26).
 *
 * The output is committed, like the other icons. Pure text, no macOS tools, so it runs anywhere:
 *
 *   node scripts/make-icon-composer.mjs
 *
 * The document format (icon.json + Assets/) is Icon Composer's; Apple publishes no schema. The keys
 * used here — `fill-specializations`, `image-name-specializations`, appearance `dark` — are the
 * ones Icon Composer itself writes.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.join(here, '..')
const source = path.join(desktopDir, '..', 'media', 'favicon.svg')
const out = path.join(desktopDir, 'build', 'icon.icon')

const TEAL = '#0FBFA6'
const INK = '#0B0D12'

const svg = fs.readFileSync(source, 'utf-8')
// favicon.svg is a 128-unit tile (one <rect … rx="22" fill="#0FBFA6"/>) with the bird drawn in INK.
const tile = /<rect width="128" height="128" rx="22" fill="#0FBFA6"\/>/
if (!tile.test(svg)) throw new Error('make-icon-composer: media/favicon.svg no longer starts with the 128-unit teal tile this script expects')
if (!svg.includes(`fill="${INK}"`)) throw new Error(`make-icon-composer: media/favicon.svg no longer draws the bird in ${INK}`)

/** The bird alone, on Icon Composer's 1024-point canvas, in `color`. The fill and the rounded
 *  shape are the system's, so the tile is dropped; the bird keeps its place on it. */
function bird(color) {
  return svg
    .replace(tile, '')
    .replace('viewBox="0 0 128 128"', 'width="1024" height="1024" viewBox="0 0 128 128"')
    .replaceAll(`fill="${INK}"`, `fill="${color}"`)
}

/** `#RRGGBB` as Icon Composer's colour string. */
function color(hex) {
  const [r, g, b] = [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5))
  return `extended-srgb:${r},${g},${b},1.00000`
}

const doc = {
  'fill-specializations': [
    { value: { solid: color(TEAL) } },
    { appearance: 'dark', value: { solid: color(INK) } },
  ],
  groups: [
    {
      layers: [
        {
          // Flat, like the .icns: no glass, so the bird reads the same in every appearance.
          glass: false,
          'image-name-specializations': [
            { value: 'bird-light.svg' },
            { appearance: 'dark', value: 'bird-dark.svg' },
          ],
          name: 'bird',
        },
      ],
      shadow: { kind: 'none', opacity: 0.5 },
      translucency: { enabled: false, value: 0.5 },
    },
  ],
  'supported-platforms': { squares: ['macOS'] },
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'Assets'), { recursive: true })
fs.writeFileSync(path.join(out, 'Assets', 'bird-light.svg'), bird(INK))
fs.writeFileSync(path.join(out, 'Assets', 'bird-dark.svg'), bird(TEAL))
fs.writeFileSync(path.join(out, 'icon.json'), JSON.stringify(doc, null, 2) + '\n')
console.log(`icon.icon  light: ${TEAL} fill, ${INK} bird · dark: ${INK} fill, ${TEAL} bird`)
