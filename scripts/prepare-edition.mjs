#!/usr/bin/env node
// Rewrites package.json for packing a given edition, keeping the original to restore afterwards.
//
//   node scripts/prepare-edition.mjs core      package.json → the core manifest (backup kept)
//   node scripts/prepare-edition.mjs full      no manifest changes (the checked-in file is full)
//   node scripts/prepare-edition.mjs restore   put the checked-in package.json back
//   node scripts/prepare-edition.mjs core --out <file>   write the core manifest elsewhere instead
//
// The core manifest drops everything that only makes sense with TraceRoost Cloud built in:
//   - the Org commands (`traceRoost.org*`) from contributes.commands / menus / activationEvents
//   - the BSL LICENSE files of the cloud directories from `files` (nothing from them is bundled),
//     and every cloud directory from the VSIX via an appended .vscodeignore block
// and points `vscode:prepublish` / `prepublishOnly` at `package:core`, so `vsce package` and
// `npm publish` rebuild the core bundles (and re-run scripts/check-edition.mjs) rather than the
// full ones. Release workflows run `core` before packing and `restore` after; see
// runbooks/RELEASING.md → "Editions".

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const backupPath = path.join(root, '.package.json.edition-backup')
// vsce ignores package.json's `files` and packs whatever .vscodeignore doesn't exclude, so the core
// VSIX needs the cloud directories' LICENSE files excluded there too.
const vscodeignorePath = path.join(root, '.vscodeignore')
const vscodeignoreBackupPath = path.join(root, '.vscodeignore.edition-backup')
const CORE_VSCODEIGNORE = `
# ── Core edition (added by scripts/prepare-edition.mjs core; undone by \`restore\`) ──
# No TraceRoost Cloud code is bundled in this edition, so none of the cloud directories' files ship.
**/cloud/**
`

const [mode, ...rest] = process.argv.slice(2)
const outIndex = rest.indexOf('--out')
const outPath = outIndex >= 0 ? path.resolve(rest[outIndex + 1]) : null

const isOrgCommand = (id) => typeof id === 'string' && /^traceRoost\.org/i.test(id)
const isCloudPath = (p) => /(^|\/)cloud(\/|$)/.test(p)

export function coreManifest(pkg) {
  const out = structuredClone(pkg)
  const c = out.contributes ?? {}
  if (Array.isArray(c.commands)) c.commands = c.commands.filter(cmd => !isOrgCommand(cmd.command))
  if (c.menus) {
    for (const [where, entries] of Object.entries(c.menus)) {
      c.menus[where] = entries.filter(m => !isOrgCommand(m.command))
      if (c.menus[where].length === 0) delete c.menus[where]
    }
  }
  if (Array.isArray(c.walkthroughs)) {
    for (const w of c.walkthroughs) {
      w.steps = (w.steps ?? []).filter(s => !/traceRoost\.org|TraceRoost Cloud/.test(JSON.stringify(s)))
    }
  }
  if (Array.isArray(out.activationEvents)) out.activationEvents = out.activationEvents.filter(e => !/traceRoost\.org/i.test(e))
  if (Array.isArray(out.files)) out.files = out.files.filter(f => !isCloudPath(f))
  out.scripts = { ...out.scripts, 'vscode:prepublish': 'pnpm run package:core', prepublishOnly: 'pnpm run package:core' }
  return out
}

function write(file, pkg) {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
}

if (mode === 'restore') {
  if (fs.existsSync(vscodeignoreBackupPath)) {
    fs.copyFileSync(vscodeignoreBackupPath, vscodeignorePath)
    fs.rmSync(vscodeignoreBackupPath)
  }
  if (!fs.existsSync(backupPath)) {
    console.log('prepare-edition: nothing to restore (package.json was not rewritten)')
    process.exit(0)
  }
  fs.copyFileSync(backupPath, pkgPath)
  fs.rmSync(backupPath)
  console.log('prepare-edition: restored the checked-in package.json and .vscodeignore')
} else if (mode === 'full') {
  console.log('prepare-edition: full edition — package.json unchanged')
} else if (mode === 'core') {
  // Always derive from the checked-in manifest, even if a previous run left package.json rewritten.
  const source = fs.existsSync(backupPath) ? backupPath : pkgPath
  const pkg = JSON.parse(fs.readFileSync(source, 'utf8'))
  const core = coreManifest(pkg)
  if (outPath) {
    write(outPath, core)
    console.log(`prepare-edition: core manifest written to ${path.relative(root, outPath) || outPath}`)
  } else {
    if (!fs.existsSync(backupPath)) fs.copyFileSync(pkgPath, backupPath)
    write(pkgPath, core)
    if (!fs.existsSync(vscodeignoreBackupPath)) {
      fs.copyFileSync(vscodeignorePath, vscodeignoreBackupPath)
      fs.appendFileSync(vscodeignorePath, CORE_VSCODEIGNORE)
    }
    const dropped = (pkg.contributes?.commands ?? []).length - (core.contributes?.commands ?? []).length
    console.log(`prepare-edition: package.json rewritten for the core edition (${dropped} Org commands dropped, cloud files removed); restore with \`node scripts/prepare-edition.mjs restore\``)
  }
} else {
  console.error('usage: node scripts/prepare-edition.mjs <core|full|restore> [--out <file>]')
  process.exit(2)
}
