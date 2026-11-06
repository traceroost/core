/**
 * Renders the DMG window's background, build/background.png and build/background@2x.png, which
 * electron-builder combines into one HiDPI image. The window is the background's 1x size.
 *
 * The background says what to do: double-click the app, which then offers to move itself to
 * Applications and opens from there (src/installLocation.ts). Dragging to the Applications link
 * still works, and the arrow says so. The icon positions in electron-builder.cjs's `dmg.contents`
 * are the centres drawn here (ICON_Y, APP_X, APPLICATIONS_X); change both together.
 *
 * Rendered by Playwright's Chromium (a root dev dependency, already used for the UX tests) so the
 * text is set in the system font at both scales. The PNGs are committed, so this only has to run
 * when the design changes:
 *
 *   node desktop/scripts/make-dmg-background.mjs
 */

import { createRequire } from 'module'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const buildDir = path.join(here, '..', 'build')
const require = createRequire(path.join(here, '..', '..', 'package.json'))
const { chromium } = require('playwright')

export const WIDTH = 600
export const HEIGHT = 400
export const ICON_Y = 205
export const APP_X = 165
export const APPLICATIONS_X = 435

const TEAL = '#0FBFA6'
const INK = '#0B0D12'

const html = `<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body {
    position: relative;
    font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
    background: linear-gradient(180deg, #FFFFFF 0%, #F1F4F5 100%);
    color: ${INK};
    -webkit-font-smoothing: antialiased;
  }
  .title { position: absolute; top: 34px; width: 100%; text-align: center; font-size: 21px; font-weight: 600; letter-spacing: -0.2px; }
  .sub { position: absolute; top: 68px; width: 100%; text-align: center; font-size: 13px; color: #5B6470; }
  .arrow { position: absolute; left: ${APP_X + 80}px; width: ${APPLICATIONS_X - APP_X - 160}px; top: ${ICON_Y - 30}px; text-align: center; }
  .arrow .label { font-size: 11px; color: #8A929C; margin-bottom: 6px; }
  .arrow svg { display: block; margin: 0 auto; }
  .hint { position: absolute; top: ${ICON_Y + 104}px; width: 160px; text-align: center; font-size: 12px; font-weight: 600; }
  .hint span { display: inline-block; padding: 4px 10px; border-radius: 999px; }
  .primary { left: ${APP_X - 80}px; }
  .primary span { background: ${TEAL}; color: #FFFFFF; }
</style></head><body>
  <div class="title">Double-click TraceRoost to install</div>
  <div class="sub">It moves itself to Applications and opens.</div>
  <div class="arrow">
    <div class="label">or drag</div>
    <svg width="${APPLICATIONS_X - APP_X - 160}" height="14" viewBox="0 0 ${APPLICATIONS_X - APP_X - 160} 14">
      <line x1="2" y1="7" x2="${APPLICATIONS_X - APP_X - 172}" y2="7" stroke="#B4BAC2" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 6"/>
      <path d="M${APPLICATIONS_X - APP_X - 172} 2 L${APPLICATIONS_X - APP_X - 164} 7 L${APPLICATIONS_X - APP_X - 172} 12" fill="none" stroke="#B4BAC2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </div>
  <div class="hint primary"><span>Double-click</span></div>
</body></html>`

const browser = await chromium.launch()
try {
  for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: scale })
    await page.setContent(html)
    await page.screenshot({ path: path.join(buildDir, name), omitBackground: false })
    await page.close()
    console.log(`make-dmg-background: wrote build/${name} (${WIDTH * scale}×${HEIGHT * scale})`)
  }
} finally {
  await browser.close()
}
