import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runAgentsCli } from './agentsCli'
import { readAgentSetupAnswer } from '../src/agentSetupConsent'

suite('traceroost agents', () => {
  let home: string
  const saved: Record<string, string | undefined> = {}
  const out: string[] = []
  const io = (env: NodeJS.ProcessEnv = {}) => ({ log: (l: string) => out.push(l), error: (l: string) => out.push(`ERR ${l}`), env })

  setup(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'traceroost-agents-cli-'))
    for (const k of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'APPDATA']) saved[k] = process.env[k]
    process.env.HOME = home
    process.env.USERPROFILE = home
    process.env.APPDATA = path.join(home, 'AppData', 'Roaming')
    delete process.env.CODEX_HOME
    out.length = 0
  })
  teardown(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('setup then remove gives back the user\'s files and records yes, then no', async () => {
    const claude = path.join(home, '.claude', 'settings.json')
    const codex = path.join(home, '.codex', 'config.toml')
    const claudeOriginal = JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }, null, 2) + '\n'
    const codexOriginal = 'model = "o3"\n'
    fs.mkdirSync(path.dirname(claude), { recursive: true }); fs.writeFileSync(claude, claudeOriginal)
    fs.mkdirSync(path.dirname(codex), { recursive: true }); fs.writeFileSync(codex, codexOriginal)

    assert.strictEqual(await runAgentsCli(['setup', '--otlp-port', '4399'], io()), 0)
    assert.strictEqual(readAgentSetupAnswer(home), 'yes')
    assert.match(fs.readFileSync(claude, 'utf-8'), /localhost:4399/)
    assert.match(fs.readFileSync(codex, 'utf-8'), /localhost:4399/)

    out.length = 0
    assert.strictEqual(await runAgentsCli(['remove'], io()), 0)
    assert.strictEqual(readAgentSetupAnswer(home), 'no')
    assert.strictEqual(fs.readFileSync(claude, 'utf-8'), claudeOriginal)
    assert.strictEqual(fs.readFileSync(codex, 'utf-8'), codexOriginal)
    assert.ok(out.some(l => l.includes('~/.claude/settings.json') || l.includes(claude)), out.join('\n'))
    assert.ok(out.some(l => l.includes("won't set up your agents again")), out.join('\n'))
  })

  test('changes nothing with TRACEROOST_NO_AUTOCONFIG=1', async () => {
    assert.strictEqual(await runAgentsCli(['setup'], io({ TRACEROOST_NO_AUTOCONFIG: '1' })), 1)
    assert.strictEqual(await runAgentsCli(['remove'], io({ TRACEROOST_NO_AUTOCONFIG: '1' })), 1)
    assert.strictEqual(readAgentSetupAnswer(home), undefined)
    assert.ok(!fs.existsSync(path.join(home, '.claude')))
  })

  test('--help on a subcommand prints its usage and succeeds, changing nothing', async () => {
    for (const sub of ['setup', 'remove']) {
      out.length = 0
      assert.strictEqual(await runAgentsCli([sub, '--help'], io()), 0, sub)
      assert.match(out.join('\n'), new RegExp(`^Usage: traceroost agents ${sub}`), sub)
      assert.ok(!out.some(l => l.startsWith('ERR')), out.join('\n'))
    }
    assert.strictEqual(await runAgentsCli(['setup', '-h'], io()), 0)
    assert.strictEqual(readAgentSetupAnswer(home), undefined)
    assert.ok(!fs.existsSync(path.join(home, '.claude')))
  })

  test('a bad --otlp-port is reported as an invalid port, not an unknown option', async () => {
    for (const args of [['setup', '--otlp-port', 'abc'], ['setup', '--otlp-port', '70000'], ['setup', '--otlp-port']]) {
      out.length = 0
      assert.strictEqual(await runAgentsCli(args, io()), 1, args.join(' '))
      assert.match(out.join('\n'), /Invalid --otlp-port/, args.join(' '))
      assert.doesNotMatch(out.join('\n'), /Unknown option/)
    }
    assert.strictEqual(readAgentSetupAnswer(home), undefined)
  })

  test('an unknown option is still refused', async () => {
    assert.strictEqual(await runAgentsCli(['remove', '--force'], io()), 1)
    assert.match(out.join('\n'), /Unknown option: --force/)
  })

  test('an unknown subcommand prints the usage and fails', async () => {
    assert.strictEqual(await runAgentsCli(['frobnicate'], io()), 1)
    assert.match(out.join('\n'), /traceroost agents <setup\|remove>/)
  })
})
