import * as assert from 'assert'
import { changedFiles, describeRemoval, tildePath } from '../agentSetupRemoval'

suite('agentSetupRemoval', function () {
  // Paths below are POSIX; tildePath splits on the platform's separator.
  if (process.platform === 'win32') return
  const home = '/home/u'

  test('names each changed file, shortened under the home directory', () => {
    assert.strictEqual(tildePath('/home/u/.claude/settings.json', home), '~/.claude/settings.json')
    assert.strictEqual(tildePath('/etc/x', home), '/etc/x')
    assert.deepStrictEqual(changedFiles([
      { agent: 'Claude Code', file: '/home/u/.claude/settings.json', changed: true },
      { agent: 'Codex', file: '/home/u/.codex/config.toml', changed: false },
    ], home), ['Claude Code (~/.claude/settings.json)'])
  })

  test('says what changed, what was left alone and what failed, and that setup stops', () => {
    const text = describeRemoval([
      { agent: 'Claude Code', file: '/home/u/.claude/settings.json', changed: true },
      { agent: 'Codex', file: '/home/u/.codex/config.toml', changed: false, warning: 'exports elsewhere' },
      { agent: 'Copilot', file: '/home/u/.config/Code/User/settings.json', changed: false, error: 'EACCES' },
    ], home)
    assert.match(text, /Removed TraceRoost's settings from Claude Code \(~\/\.claude\/settings\.json\)\./)
    assert.match(text, /Left one file alone/)
    assert.match(text, /Could not change Copilot \(~\/\.config\/Code\/User\/settings\.json\)/)
    assert.match(text, /won't set up your agents again/)
  })

  test('says so when there was nothing to remove', () => {
    assert.match(describeRemoval([{ agent: 'Codex', file: '/home/u/.codex/config.toml', changed: false }], home), /^No TraceRoost agent settings were found/)
  })
})
