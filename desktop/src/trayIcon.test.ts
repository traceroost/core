import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { chooseTrayIcon } from './trayIcon'

const BUILD_DIR = path.join(__dirname, '..', '..', '..', '..', 'desktop', 'build')

suite('trayIcon — which image, per platform and appearance', () => {
  test('Windows picks a white glyph for a dark taskbar and a black one for a light taskbar', () => {
    const dark = chooseTrayIcon('/assets', 'win32', true)
    const light = chooseTrayIcon('/assets', 'win32', false)
    assert.strictEqual(path.basename(dark.file), 'trayForDarkTaskbar.ico')
    assert.strictEqual(path.basename(light.file), 'trayForLightTaskbar.ico')
    assert.notStrictEqual(dark.file, light.file)
    // Template marking is a macOS concept; on Windows the ICO must be shown as drawn.
    assert.strictEqual(dark.template, false)
    assert.strictEqual(light.template, false)
  })

  test('macOS uses the one template image regardless of appearance — the system recolours it', () => {
    const dark = chooseTrayIcon('/assets', 'darwin', true)
    const light = chooseTrayIcon('/assets', 'darwin', false)
    assert.strictEqual(dark.file, light.file)
    assert.strictEqual(path.basename(dark.file), 'trayTemplate.png')
    assert.strictEqual(dark.template, true)
  })

  test('Linux gets the monochrome glyph, not marked as a template', () => {
    const choice = chooseTrayIcon('/assets', 'linux', true)
    assert.strictEqual(path.basename(choice.file), 'trayTemplate.png')
    assert.strictEqual(choice.template, false)
  })

  test('every file the chooser can name is committed in desktop/build', () => {
    const named = new Set<string>()
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const dark of [true, false]) named.add(path.basename(chooseTrayIcon(BUILD_DIR, platform, dark).file))
    }
    for (const file of named) {
      assert.ok(fs.existsSync(path.join(BUILD_DIR, file)), `${file} is missing from desktop/build — run scripts/make-icons.mjs`)
    }
  })

  test('the Windows ICOs are real multi-frame icons with the DPI sizes the taskbar asks for', () => {
    for (const name of ['trayForDarkTaskbar.ico', 'trayForLightTaskbar.ico']) {
      const ico = fs.readFileSync(path.join(BUILD_DIR, name))
      assert.strictEqual(ico.readUInt16LE(2), 1, `${name}: not an icon resource`)
      const count = ico.readUInt16LE(4)
      const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + 16 * i))
      for (const expected of [16, 20, 24, 32]) assert.ok(sizes.includes(expected), `${name} lacks a ${expected} px frame (has ${sizes.join(',')})`)
      // Each frame is PNG-encoded: the directory offset must land on a PNG signature.
      for (let i = 0; i < count; i++) {
        const offset = ico.readUInt32LE(6 + 16 * i + 12)
        assert.strictEqual(ico.subarray(offset, offset + 8).toString('hex'), '89504e470d0a1a0a', `${name} frame ${i} is not PNG`)
      }
    }
  })
})
