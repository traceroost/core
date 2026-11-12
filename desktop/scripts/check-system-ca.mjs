/**
 * Proves that the packaged app's collector trusts a company root certificate that lives only in
 * the operating system's certificate store: the HTTPS-inspection case (Zscaler and the like), where
 * every site's certificate is re-signed by a root that IT installed on the machine.
 *
 *   node scripts/check-system-ca.mjs [path\to\traceroost-desktop.exe]   # Windows, elevated
 *   node scripts/check-system-ca.mjs [path/to/traceroost-desktop]       # Debian/Ubuntu, as root
 *
 * Defaults to the unpacked build for this machine's architecture under dist/, as smoke-packaged.mjs
 * does. Exit code 0 means every check passed.
 *
 * What it does, start to finish:
 *   1. makes a throwaway root CA and a server certificate signed by it (openssl; both expire in
 *      two days and the keys never leave a temporary directory);
 *   2. installs the root where IT would: the machine's Root store on Windows (certutil), or
 *      /usr/local/share/ca-certificates + update-ca-certificates on Debian and Ubuntu;
 *   3. serves HTTPS on 127.0.0.1 with the server certificate, which nothing but that root vouches
 *      for;
 *   4. runs the packaged binary as Node, the way desktop/src/collector.ts runs the collector
 *      (ELECTRON_RUN_AS_NODE=1, NODE_USE_SYSTEM_CA=1), and has it fetch() that server: it must
 *      succeed;
 *   5. runs it again with NODE_USE_SYSTEM_CA=0: it must fail on the certificate. That is the
 *      control: without it, a pass in step 4 could mean the request was never verified at all;
 *   6. removes the root from the store again, pass or fail.
 *
 * collector.test.ts covers that the app hands NODE_USE_SYSTEM_CA=1 to its collector. This covers
 * the other half, which only a real binary on a real OS can: that the Node inside Electron (built
 * against BoringSSL, not OpenSSL) acts on that setting and reads this platform's store.
 *
 * Not for a developer's own machine: it changes the machine-wide trust store (and puts it back).
 * macOS is not supported here, because trusting a root in the keychain needs an interactive
 * password prompt.
 */

import { execFileSync, spawn } from 'child_process'
import { X509Certificate } from 'crypto'
import * as fs from 'fs'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'

const desktopDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'
const CHILD_TIMEOUT_MS = 60_000
const ROOT_NAME = 'TraceRoost CI HTTPS inspection root'

if (!isWindows && !isLinux) {
  console.error('system-ca: only Windows and Debian/Ubuntu are supported (macOS needs an interactive keychain prompt)')
  process.exit(2)
}
const binary = path.resolve(process.argv[2] ?? (isWindows
  ? path.join(desktopDir, 'dist', process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked', 'traceroost-desktop.exe')
  : path.join(desktopDir, 'dist', process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked', 'traceroost-desktop')))
if (!fs.existsSync(binary)) {
  console.error(`system-ca: ${binary} does not exist. Run \`pnpm run pack:win:host\` / \`pnpm run pack:linux:host\` (or pass the path)`)
  process.exit(2)
}

const failures = []
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? '  ✔' : '  ✘'} ${what}`) }

// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a CI check running fixed tools with arguments it built itself
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-system-ca-'))
const file = (name) => path.join(tmp, name)

/** A root CA and a 127.0.0.1 server certificate signed by it. Explicit configs, so nothing depends on the machine's openssl.cnf. */
function makeCertificates() {
  fs.writeFileSync(file('root.cnf'), [
    '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', `CN = ${ROOT_NAME}`, 'O = TraceRoost CI',
    '[v3]', 'basicConstraints = critical, CA:TRUE', 'keyUsage = critical, keyCertSign, cRLSign', 'subjectKeyIdentifier = hash',
    '',
  ].join('\n'))
  fs.writeFileSync(file('leaf.cnf'), [
    '[req]', 'distinguished_name = dn', 'prompt = no',
    '[dn]', 'CN = 127.0.0.1',
    '[v3]', 'basicConstraints = CA:FALSE', 'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth', 'subjectAltName = IP:127.0.0.1, DNS:localhost',
    '',
  ].join('\n'))
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', file('root.cnf'), '-keyout', file('root.key'), '-out', file('root.crt')])
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', file('leaf.cnf'), '-keyout', file('leaf.key'), '-out', file('leaf.csr')])
  run('openssl', ['x509', '-req', '-in', file('leaf.csr'), '-CA', file('root.crt'), '-CAkey', file('root.key'), '-CAcreateserial',
    '-days', '2', '-extfile', file('leaf.cnf'), '-extensions', 'v3', '-out', file('leaf.crt')])
  return { root: fs.readFileSync(file('root.crt'), 'utf8'), leaf: fs.readFileSync(file('leaf.crt'), 'utf8'), leafKey: fs.readFileSync(file('leaf.key'), 'utf8') }
}

// Where IT puts a company root. Windows: the machine's Root store (the per-user Root store would
// raise a confirmation dialog, and a managed laptop gets its root machine-wide anyway).
const certutil = isWindows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'certutil.exe') : undefined
const linuxAnchor = '/usr/local/share/ca-certificates/traceroost-ci-inspection-root.crt'

function installRoot() {
  if (isWindows) {
    run(certutil, ['-addstore', '-f', 'Root', file('root.crt')])
  } else {
    fs.copyFileSync(file('root.crt'), linuxAnchor)
    run('update-ca-certificates', [])
  }
}

function removeRoot(sha1) {
  try {
    if (isWindows) {
      run(certutil, ['-delstore', 'Root', sha1])
    } else {
      fs.rmSync(linuxAnchor, { force: true })
      run('update-ca-certificates', ['--fresh'])
    }
  } catch (e) {
    failures.push(`could not remove the test root from the OS store: ${String(e.stderr || e.message).trim()}`)
  }
}

// What the packaged binary runs, as Node. It reports one JSON line: whether the fetch worked, and
// whether Node's view of the OS store contains the test root (which tells a store that was never
// read apart from a root that was read and still not trusted).
const CHILD = `
const tls = require('tls'), { X509Certificate } = require('crypto')
const inStore = (() => {
  try { return tls.getCACertificates('system').some((pem) => new X509Certificate(pem).fingerprint256 === process.env.CHECK_ROOT_FP) }
  catch (e) { return 'error: ' + e.message }
})()
fetch(process.env.CHECK_URL).then(
  async (r) => console.log(JSON.stringify({ ok: true, status: r.status, body: await r.text(), inStore, node: process.versions.node })),
  (e) => console.log(JSON.stringify({ ok: false, error: String(e.cause?.code ?? e.cause?.message ?? e.message), inStore, node: process.versions.node })),
)`

function fetchFromPackagedNode(url, rootFingerprint, useSystemCa) {
  return new Promise((resolve) => {
    // Nothing inherited may decide the outcome: no extra CA file, no proxy in front of 127.0.0.1.
    const { NODE_EXTRA_CA_CERTS: _a, NODE_OPTIONS: _b, HTTPS_PROXY: _c, https_proxy: _d, ...inherited } = process.env
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process -- a CI check running the app binary it just packed
    const child = spawn(binary, ['-e', CHILD], {
      env: { ...inherited, ELECTRON_RUN_AS_NODE: '1', NODE_USE_SYSTEM_CA: useSystemCa ? '1' : '0', CHECK_URL: url, CHECK_ROOT_FP: rootFingerprint },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => child.kill(), CHILD_TIMEOUT_MS)
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `could not run ${binary}: ${e.message}` }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = out.trim().split('\n').pop() ?? ''
      try { resolve(JSON.parse(line)) }
      catch { resolve({ ok: false, error: `no result from the packaged binary (exit ${code}): ${(err || out).trim()}` }) }
    })
  })
}

console.log(`system-ca: ${binary}`)
let rootSha1
let server
try {
  const certs = makeCertificates()
  const root = new X509Certificate(certs.root)
  rootSha1 = root.fingerprint.replaceAll(':', '')
  installRoot()
  console.log(`  installed "${ROOT_NAME}" (${rootSha1}) in the OS store`)

  server = https.createServer({ key: certs.leafKey, cert: certs.leaf }, (_req, res) => res.end('inspected'))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const url = `https://127.0.0.1:${server.address().port}/`

  const on = await fetchFromPackagedNode(url, root.fingerprint256, true)
  check(on.inStore === true, `the packaged Node (${on.node ?? '?'}) sees the test root in the OS store${on.inStore === true ? '' : ` (${on.inStore})`}`)
  check(on.ok && on.body === 'inspected', `NODE_USE_SYSTEM_CA=1: fetch through the test root succeeds${on.ok ? '' : ` (${on.error})`}`)

  const off = await fetchFromPackagedNode(url, root.fingerprint256, false)
  check(!off.ok, `NODE_USE_SYSTEM_CA=0: the same fetch is refused${off.ok ? ' (it succeeded: the check proves nothing)' : ` (${off.error})`}`)
} catch (e) {
  failures.push(`${e.message}${e.stderr ? `: ${String(e.stderr).trim()}` : ''}`)
} finally {
  server?.close()
  if (rootSha1) removeRoot(rootSha1)
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`\nsystem-ca: FAILED\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  process.exit(1)
}
console.log('\nsystem-ca: the packaged collector trusts a root from the OS certificate store')
