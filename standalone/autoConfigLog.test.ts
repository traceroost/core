import * as assert from 'assert'
import { autoConfigLogLines } from './autoConfigLog'

suite('autoConfigLogLines', () => {
  test('surfaces every agent\'s warning, not just Claude Code\'s', () => {
    const lines = autoConfigLogLines(
      { changed: false, warning: 'claude: left as is' },
      { changed: false, warning: '[otel] endpoint in config.toml points at https://collector.example; left as is' },
      [{ changed: false, warning: 'copilot: left as is' }, { changed: true }],
    )
    const warnings = lines.filter(l => l.level === 'warn').map(l => l.text)
    assert.deepStrictEqual(warnings, [
      '[TraceRoost] claude: left as is',
      '[TraceRoost] [otel] endpoint in config.toml points at https://collector.example; left as is',
      '[TraceRoost] copilot: left as is',
    ])
    assert.ok(lines.some(l => l.level === 'log' && l.text.includes('Copilot configured')))
  })

  test('reports errors and changes per agent, and nothing when there is nothing to say', () => {
    const lines = autoConfigLogLines({ changed: true }, { changed: false, error: 'EACCES' }, [{ changed: false, error: 'bad json' }])
    assert.deepStrictEqual(lines.map(l => `${l.level}: ${l.text}`), [
      'log: [TraceRoost] Claude Code configured — restart Claude Code in your terminal to activate tracing',
      'warn: [TraceRoost] Could not auto-configure Codex: EACCES',
      'warn: [TraceRoost] Could not auto-configure Copilot: bad json',
    ])
    assert.deepStrictEqual(autoConfigLogLines({ changed: false }, { changed: false }, []), [])
  })
})
