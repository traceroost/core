// scripts/otel-watch.mjs end to end: a fake upstream (pages + the GitHub commits API) on a local
// HTTP server, a fake SMTP relay over TLS, and the script run as a child process the way the
// workflow runs it. Covers: the first run only records a baseline (no mail), a telemetry-related
// line change is reported and mailed, an unrelated change in a `match`ed source is quiet, a new
// commit on a watched path is reported once, a page that disappears is reported as a status change,
// and an unreachable source is reported instead of failing the run.
import * as assert from 'assert'
import * as http from 'http'
import * as tls from 'tls'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import type { AddressInfo } from 'net'

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'otel-watch.mjs')

// Self-signed, CN=localhost, SAN localhost/127.0.0.1, 100-year validity. Test fixture only.
const CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUTvPI6o8wGP8KoKeTUQm7GkNzXs0wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxODE5NTQxNFoYDzIxMjYw
OTI0MTk1NDE0WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDFUB0jyyWhBwgootvAguSpebh+Zs0PiDxF6xvSTwxS
ncNhWBAj4wxacPy8Gei068iruDvAL7SS5maGXfv/mKf56uuwTpvg1y3eaQkF/Z2N
coyE55DgIOnVJwPL+nshN9l0DXTCBWxQyFaQ8iLaKieKINJUdr3GFxcbn6twCuQF
ji/1y3c0/YXtM6Kn3d38LzQqDTgasIoDVz9KQRYnAfbg7lopbfsohNJF6Qgwebs8
nSQSmXjP1cl6nwtImxjQIP6cqAfyzHmctTXU5zQ5tp9wqFKnrPJAieA0MndHcqAE
TVrByOrY+PYJSdPkOIj3XDAZxsjEckSDOVIWW+dq6UdvAgMBAAGjbzBtMB0GA1Ud
DgQWBBSejCGpjVlD9e6KA0aJxfeekTdW4TAfBgNVHSMEGDAWgBSejCGpjVlD9e6K
A0aJxfeekTdW4TAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAsg9+PsM4A/oRKoHfsRUNEVGb669T
W8yFUfjIYNvcLRC1k79jTYM/pq9FlpeHm5O5IQHZ+KnMtaKDE4Er1zJ+RsjlFFJN
uN7sVDDKiOWFEK3JXQTlUz50kUXKTNi0G/vnvfcqLW/vsxpW0KOk+7iKqDM4YgAd
9XuNEYgpml5FzcxOkCDNtixWGAaAE3ycUO3WavPbT0/mwzFtyqzpsa13xjNgsHZr
6it51t/IbbSPpYHPwTS0sIN+ahXcAp7Vb7AYV2V/NGvBoMBZ0Y8hMBC9bwAvVux2
e53/4IliScGyvJe2ZnI9y2aucC9yk0WFXyEXUIE2sh6WnY6LttRkkrRszQ==
-----END CERTIFICATE-----
`
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDFUB0jyyWhBwgo
otvAguSpebh+Zs0PiDxF6xvSTwxSncNhWBAj4wxacPy8Gei068iruDvAL7SS5maG
Xfv/mKf56uuwTpvg1y3eaQkF/Z2NcoyE55DgIOnVJwPL+nshN9l0DXTCBWxQyFaQ
8iLaKieKINJUdr3GFxcbn6twCuQFji/1y3c0/YXtM6Kn3d38LzQqDTgasIoDVz9K
QRYnAfbg7lopbfsohNJF6Qgwebs8nSQSmXjP1cl6nwtImxjQIP6cqAfyzHmctTXU
5zQ5tp9wqFKnrPJAieA0MndHcqAETVrByOrY+PYJSdPkOIj3XDAZxsjEckSDOVIW
W+dq6UdvAgMBAAECggEAO90MEj2Cq6HSCF4s1PIBhSegYX04DtPTEZV8yehgwToL
Op/4uaKbr17jVwB3WVjF9898FVmD7CPKDE88cvYyVIFBQ6r94Q/34ygz7CTfpbgQ
yQvmqRFjUF+3Z64VqGTk7TBd8bWqgLHfjbdg+pbaiy5dEfI6rnx37tIZNfOf7c0G
7eteAFv89DOQJ7XTDVIWsaZYNU6uq8Qay+Xib8YbfqKkg8IoA0fXumrs7G6s9hw4
Gml5e5KwHvYO67UmavaP9NH8Eo4OGNja3xNzXpK1s/P2W7FvO9sM9Avq3nPgWJtg
4giTsFVbQCJg71pFLKnrwRnZb+/dxZsscDHb4yXlxQKBgQDoNsQVYHrCp5PWeZbG
/yvML2wxgPtoVVEqxvbVK/CcfOM/ExyzW9AjH9WX9EmkMqGHTtCuyYs789x5I87t
DvAgTDiPadE2DTo9d/auoWnydwvNjkJwkoW2QLCvXuJs1wBz+71zsM92WyRVDouL
NrHHQ27cmg/biIIy/Fu/WD9cLQKBgQDZhif56cEyMAhZ0KnydCMszxQufDZbsfdl
OECS7zqJaDuAQPUQ9Zrm4ZkpAYp8mYfCqSAqq41vml3Jc4ie4aR/8svc+pa9i79J
3NeQev0SjNxRZdGmK5HPhBahO89See3y0BggChQ/W11xXvJCI5VBx9uU7WXozXx0
vCAL/hEHiwKBgQDm669K4sqxUBxAKGG8Ony/bFlXUUCxnEY/F+TWT//SXo9NZiAg
bKkqhLnPhmrFEmR3PfVgG6SOVg9lmCpqq3Q3ahTE6SHXcof8IJP7TSEisSfXniSL
9elqOCJ8Awt/2L7ml+zqY2Wr+S7ENtal9hoMYg6Y6cvjMHjpYvOJ8KPxcQKBgAjS
ehiWtHE2pYAPCHV+5FZS57yi6Ql7BE+komnTLgqYoaEoAUh4zZmDmNSi7Vz0VR8+
AMH6Rzg5iIg9GVNoT2WpET+bIjX5zv5N6KhBdLYl5GGgwYn9xmImN0y+wj/UFiR8
8B2MixmuuPF6KlUoYEtUscEuh62Td/K8Foil+0bVAoGBALS773H03TnXlN6dV7xw
x8Mak/zkfeLXxNV3tVep/9WHjJCsXY8zw9AYDRDsezwNQwF/NiKpPM9pc80mdLTy
RzMqHu7EAE26UIVraaOkgpQ8NksUiaqdzudTP8JsiMcZqdLa+jNKPy7WaqJ5laPI
XkR2etGFxK+sApvXYsACujgE
-----END PRIVATE KEY-----
`

type Commit = { sha: string; date: string; message: string }

/** Fake upstream: `/page/<name>` serves `pages[name]` (404 when absent); `/repos/<o>/<r>/commits` is
 *  the GitHub commits API over `commits[path]`, honouring `path` and `since`. */
function upstream(pages: Record<string, string>, commits: Record<string, Commit[]>) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname.startsWith('/page/')) {
      const body = pages[url.pathname.slice('/page/'.length)]
      if (body === undefined) { res.writeHead(404); res.end('gone'); return }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body); return
    }
    if (url.pathname.endsWith('/commits')) {
      const p = url.searchParams.get('path') ?? ''
      const since = url.searchParams.get('since')
      const list = (commits[p] ?? [])
        .filter(c => !since || c.date >= since)
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map(c => ({ sha: c.sha, html_url: `https://example.test/commit/${c.sha}`, commit: { message: c.message, committer: { date: c.date } } }))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(list)); return
    }
    res.writeHead(500); res.end('unexpected ' + url.pathname)
  })
  return server
}

/** Fake SMTP relay over implicit TLS: AUTH LOGIN, one message per connection, records what it got. */
function smtpRelay(received: { auth: string[]; from: string; to: string[]; data: string }[]) {
  return tls.createServer({ cert: CERT, key: KEY }, socket => {
    socket.setEncoding('utf8')
    let buf = ''
    let inData = false
    const msg = { auth: [] as string[], from: '', to: [] as string[], data: '' }
    const say = (s: string) => socket.write(s + '\r\n')
    say('220 fake-ses ESMTP')
    socket.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        if (inData) {
          if (line === '.') { inData = false; received.push({ ...msg }); say('250 queued') }
          else msg.data += (line.startsWith('..') ? line.slice(1) : line) + '\n'
          continue
        }
        const [verb] = line.split(' ')
        if (verb === 'EHLO') { say('250-fake-ses'); say('250 AUTH LOGIN PLAIN') }
        else if (verb === 'AUTH') say('334 VXNlcm5hbWU6')
        else if (msg.auth.length === 0) { msg.auth.push(Buffer.from(line, 'base64').toString()); say('334 UGFzc3dvcmQ6') }
        else if (msg.auth.length === 1) { msg.auth.push(Buffer.from(line, 'base64').toString()); say('235 ok') }
        else if (verb === 'MAIL') { msg.from = line.replace(/^MAIL FROM:<|>$/g, ''); say('250 ok') }
        else if (verb === 'RCPT') { msg.to.push(line.replace(/^RCPT TO:<|>$/g, '')); say('250 ok') }
        else if (verb === 'DATA') { inData = true; say('354 go') }
        else if (verb === 'QUIT') { say('221 bye'); socket.end() }
        else say('500 ?')
      }
    })
  })
}

function listen(server: http.Server | tls.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function runScript(stateDir: string, sourcesFile: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, stateDir, '--sources', sourcesFile], { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`otel-watch exited ${err.code}: ${stderr}\n${stdout}`))
      else resolve({ stdout, stderr })
    })
  })
}

suite('scripts/otel-watch.mjs', () => {
  let dir: string
  let pages: Record<string, string>
  let commits: Record<string, Commit[]>
  let api: http.Server
  let relay: tls.Server
  let received: { auth: string[]; from: string; to: string[]; data: string }[]
  let env: NodeJS.ProcessEnv
  let sourcesFile: string
  let outputFile: string

  setup(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-otel-watch-'))
    pages = {
      docs: 'Each user prompt starts a `claude_code.interaction` root span.\nSetup: export FOO=1\n',
      changelog: '## 2.0.1\n- Fixed a typo\n- Added `gen_ai.provider.name` to trace spans\n',
    }
    commits = {
      'codex-rs/otel': [{ sha: 'a'.repeat(40), date: '2026-10-01T10:00:00Z', message: 'otel: initial' }],
    }
    received = []
    api = upstream(pages, commits)
    relay = smtpRelay(received)
    const apiPort = await listen(api)
    const smtpPort = await listen(relay)
    const caFile = path.join(dir, 'ca.pem')
    fs.writeFileSync(caFile, CERT)
    outputFile = path.join(dir, 'gh-output')
    fs.writeFileSync(outputFile, '')
    env = {
      OTEL_WATCH_GITHUB_API: `http://127.0.0.1:${apiPort}`,
      OTEL_WATCH_SMTP_HOST: '127.0.0.1',
      OTEL_WATCH_SMTP_PORT: String(smtpPort),
      OTEL_WATCH_SMTP_SERVERNAME: 'localhost',
      OTEL_WATCH_SMTP_USER: 'AKIAFAKE',
      OTEL_WATCH_SMTP_PASS: 'secret',
      OTEL_WATCH_SMTP_CA: caFile,
      OTEL_WATCH_MAIL_FROM: 'TraceRoost <noreply@traceroost.test>',
      OTEL_WATCH_MAIL_TO: 'owner@example.com, second@example.com',
      GITHUB_OUTPUT: outputFile,
      GITHUB_TOKEN: '',
    }
    const base = `http://127.0.0.1:${apiPort}/page/`
    sourcesFile = path.join(dir, 'sources.json')
    fs.writeFileSync(sourcesFile, JSON.stringify([
      {
        agent: 'Claude Code',
        reads: ['src/spanSummarizer.ts'],
        sources: [
          { id: 'docs', kind: 'page', title: 'Monitoring docs', url: base + 'docs' },
          { id: 'changelog', kind: 'page', title: 'CHANGELOG', url: base + 'changelog', match: '\\b(otel|telemetry|span|spans|gen_ai)\\b' },
        ],
      },
      {
        agent: 'Codex',
        sources: [
          { id: 'codex', kind: 'repo', title: 'otel crate', repo: 'openai/codex', branch: 'main', paths: ['codex-rs/otel'] },
        ],
      },
      { agent: 'Cursor', note: 'Nothing public to watch.', sources: [] },
    ]))
  })

  teardown(async () => {
    await new Promise(r => api.close(() => r(null)))
    await new Promise(r => relay.close(() => r(null)))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const ghOutput = () => fs.readFileSync(outputFile, 'utf8')
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8'))

  test('first run records a baseline for every source and sends nothing', async () => {
    const { stdout } = await runScript(path.join(dir, 'state'), sourcesFile, env)
    assert.match(stdout, /Baseline recorded \(2 lines\)/)
    assert.match(stdout, /Baseline recorded \(latest commit aaaaaaa on 2026-10-01\)/)
    assert.match(stdout, /## Cursor\n\n_Nothing public to watch\._/)
    assert.match(ghOutput(), /changed=false/)
    assert.strictEqual(received.length, 0)
    assert.strictEqual(state().sources.docs.status, 200)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'state', 'snapshots', 'docs.txt'), 'utf8').split('\n')[0], 'Each user prompt starts a `claude_code.interaction` root span.')
    assert.strictEqual(state().sources.codex.lastCommit, 'a'.repeat(40))
  })

  test('a changed telemetry line and a new commit are reported once and mailed', async () => {
    await runScript(path.join(dir, 'state'), sourcesFile, env)
    pages.docs = 'Each user prompt starts a `claude_code.turn` root span.\nSetup: export FOO=1\n'
    pages.changelog += '## 2.0.2\n- Renamed the `claude_code.interaction` span to `claude_code.turn`\n- Fixed another typo\n'
    commits['codex-rs/otel'].push({ sha: 'b'.repeat(40), date: '2026-10-05T10:00:00Z', message: 'otel: rename turn.id\n\nlong body' })

    const { stdout } = await runScript(path.join(dir, 'state'), sourcesFile, env)
    assert.match(stdout, /- Each user prompt starts a `claude_code\.interaction` root span\.\n\+ Each user prompt starts a `claude_code\.turn` root span\./)
    assert.match(stdout, /Changed: 1 telemetry-related line\(s\) \(and 2 other changed line\(s\) not shown\)/)
    assert.match(stdout, /\+ - Renamed the `claude_code\.interaction` span/)
    assert.doesNotMatch(stdout, /Fixed another typo/)
    assert.match(stdout, /1 commit\(s\) touched `codex-rs\/otel`:\n  - 2026-10-05 \[`bbbbbbb`\]\(https:\/\/example\.test\/commit\/b+\) otel: rename turn\.id$/m)
    assert.match(ghOutput(), /changed=true/)

    assert.strictEqual(received.length, 1)
    const mail = received[0]
    assert.deepStrictEqual(mail.auth, ['AKIAFAKE', 'secret'])
    assert.strictEqual(mail.from, 'noreply@traceroost.test')
    assert.deepStrictEqual(mail.to, ['owner@example.com', 'second@example.com'])
    const subject = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(mail.data)
    assert.ok(subject)
    assert.match(Buffer.from(subject[1], 'base64').toString(), /^\[TraceRoost\] OpenTelemetry upstream changes: Claude Code, Codex \(\d{4}-\d{2}-\d{2}\)$/)
    assert.match(mail.data, /\+ Each user prompt starts a `claude_code\.turn` root span\./)

    // The run after that has nothing new: the commit is not repeated, nothing is mailed.
    const again = await runScript(path.join(dir, 'state'), sourcesFile, env)
    assert.match(again.stdout, /No commits\./)
    assert.match(again.stdout, /No change\./)
    assert.match(ghOutput(), /changed=true\nreport=[^\n]*\nchanged=false\n/)
    assert.strictEqual(received.length, 1)
  })

  test('an unrelated change in a matched source, a vanished page and an unreachable source do not mail', async () => {
    await runScript(path.join(dir, 'state'), sourcesFile, env)
    pages.changelog += '- Fixed the colour of the spinner\n'
    delete pages.docs
    const { stdout } = await runScript(path.join(dir, 'state'), sourcesFile, env)
    assert.match(stdout, /Changed, but no line matched the telemetry pattern \(1 line\(s\) differ\)/)
    // A documented page disappearing is noteworthy (it may have moved) — reported and mailed once.
    assert.match(stdout, /\*\*Status changed: HTTP 200 → HTTP 404\*\*/)
    assert.strictEqual(received.length, 1)
    // The snapshot of the last good copy stays for the next diff.
    assert.ok(fs.existsSync(path.join(dir, 'state', 'snapshots', 'docs.txt')))

    // An unreachable upstream is reported, keeps the previous state, and the run still exits 0.
    const { stdout: third } = await runScript(path.join(dir, 'state'), sourcesFile, { ...env, OTEL_WATCH_GITHUB_API: 'http://127.0.0.1:1' })
    assert.match(third, /\*\*Could not check:\*\* fetch failed/)
    assert.strictEqual(state().sources.codex.lastCommit, 'a'.repeat(40))
    assert.strictEqual(received.length, 1)
  })

  test('--no-mail stores the report and skips the relay even when something changed', async () => {
    await runScript(path.join(dir, 'state'), sourcesFile, env)
    pages.docs += 'A new `gen_ai.usage.input_tokens` attribute.\n'
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [SCRIPT, path.join(dir, 'state'), '--sources', sourcesFile, '--no-mail'], { env: { ...process.env, ...env } }, (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr)); else resolve()
      })
    })
    assert.strictEqual(received.length, 0)
    assert.match(fs.readFileSync(path.join(dir, 'state', 'latest.md'), 'utf8'), /\+ A new `gen_ai\.usage\.input_tokens` attribute\./)
    assert.strictEqual(fs.readdirSync(path.join(dir, 'state', 'reports')).length, 1) // same day, same file
  })
})
