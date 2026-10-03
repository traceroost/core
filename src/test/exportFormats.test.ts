import * as assert from 'assert'
import { toCsv, toMarkdown, serializeExport, exportFileExtension, csvCell, type ExportableSession } from '../exportFormats'

function makeSession(overrides: Partial<ExportableSession> = {}): ExportableSession {
  return {
    sessionId: 's1',
    traceId: 't1',
    source: 'claude_code',
    dataSource: 'otel',
    model: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6'],
    startTime: '2026-08-11T10:00:00.000Z',
    durationMs: 12345,
    turns: 3,
    totalToolCalls: 5,
    inputTokens: 10000,
    outputTokens: 2000,
    cacheReadTokens: 500,
    cacheCreateTokens: 100,
    cacheHitRate: 0.5,
    errors: 0,
    outcome: 'tool_calls',
    toolCounts: { read_file: 3, edit_file: 2 },
    filesRead: ['a.ts', 'b.ts'],
    filesChanged: ['a.ts'],
    loopSignals: [{ type: 'edit_revert_cycle', severity: 'critical' }],
    userRequest: 'fix the bug',
    ...overrides,
  }
}

suite('exportFormats', () => {
  suite('exportFileExtension', () => {
    test('maps each format to its extension', () => {
      assert.strictEqual(exportFileExtension('json'), 'json')
      assert.strictEqual(exportFileExtension('csv'), 'csv')
      assert.strictEqual(exportFileExtension('markdown'), 'md')
    })
  })

  suite('toCsv', () => {
    test('includes language and change-size columns (blank when unrecorded)', () => {
      const csv = toCsv([
        makeSession({ language: 'python', languageSecondary: 'typescript', filesChangedCount: 2, linesAdded: 10, linesRemoved: 4 }),
        makeSession({ sessionId: 'old' }),
      ])
      const [header, row, old] = csv.trim().split('\r\n')
      assert.ok(header.includes('"Language","Secondary Language","Files Changed (count)","Lines Added","Lines Removed"'))
      assert.ok(row.includes('"python","typescript","2","10","4"'))
      assert.ok(old.includes('"","","","",""'))
      const md = toMarkdown([makeSession({ language: 'go', filesChangedCount: 1, linesAdded: 3, linesRemoved: 0 })])
      assert.ok(md.includes('- **Language:** go'))
      assert.ok(md.includes('- **Change size:** 1 file changed, +3 / −0 lines'))
    })

    test('emits a header row followed by one row per session', () => {
      const csv = toCsv([makeSession(), makeSession({ sessionId: 's2' })])
      const lines = csv.trim().split('\r\n')
      assert.strictEqual(lines.length, 3)
      assert.ok(lines[0].startsWith('"Session ID","Trace ID"'))
    })

    test('includes the data source column', () => {
      const csv = toCsv([makeSession({ dataSource: 'log' })])
      assert.ok(csv.includes('"Data Source"'))
      assert.ok(csv.includes('"log"'))
    })

    test('quotes every field and escapes embedded quotes', () => {
      const csv = toCsv([makeSession({ userRequest: 'fix the "bug" please' })])
      assert.ok(csv.includes('"fix the ""bug"" please"'))
    })

    test('neutralizes spreadsheet formula injection with a leading apostrophe', () => {
      for (const payload of ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) {
        const csv = toCsv([makeSession({ userRequest: payload })])
        assert.ok(csv.includes(csvCell(payload)), payload)
        assert.ok(csvCell(payload).startsWith(`"'`), payload)
      }
      assert.strictEqual(csvCell('plain text'), '"plain text"')
      assert.strictEqual(csvCell('a=b'), '"a=b"')
    })

    test('preserves embedded newlines inside a quoted field', () => {
      const csv = toCsv([makeSession({ userRequest: 'line one\nline two' })])
      assert.ok(csv.includes('"line one\nline two"'))
    })

    test('flattens array and object fields with semicolon joins', () => {
      const csv = toCsv([makeSession({
        models: ['model-a', 'model-b'],
        filesChanged: ['x.ts', 'y.ts'],
        toolCounts: { read: 1, write: 2 },
        loopSignals: [{ type: 'exact_tool_repeat', severity: 'warning' }, { type: 'edit_revert_cycle', severity: 'critical' }],
      })])
      assert.ok(csv.includes('"model-a; model-b"'))
      assert.ok(csv.includes('"x.ts; y.ts"'))
      assert.ok(csv.includes('"read:1; write:2"'))
      assert.ok(csv.includes('"exact_tool_repeat(warning); edit_revert_cycle(critical)"'))
    })

    test('handles an empty session list (header only)', () => {
      const csv = toCsv([])
      assert.strictEqual(csv.trim().split('\r\n').length, 1)
    })
  })

  suite('toMarkdown', () => {
    test('includes a heading per session and the session count', () => {
      const md = toMarkdown([makeSession(), makeSession({ sessionId: 's2' })])
      assert.ok(md.includes('2 sessions,'))
      assert.match(md, /## claude-sonnet-4-6/)
    })

    test('renders the prompt as a blockquote with wrapped newlines', () => {
      const md = toMarkdown([makeSession({ userRequest: 'line one\nline two' })])
      assert.ok(md.includes('> line one\n> line two'))
    })

    test('omits the prompt section entirely when redacted to an empty string', () => {
      const md = toMarkdown([makeSession({ userRequest: '' })])
      assert.ok(!md.includes('**Prompt:**'))
    })

    test('escapes pipe characters in file paths', () => {
      const md = toMarkdown([makeSession({ filesChanged: ['weird|file.ts'] })])
      assert.ok(md.includes('weird\\|file.ts'))
    })

    test('includes a files read section and notes the data source', () => {
      const md = toMarkdown([makeSession({ dataSource: 'log', filesRead: ['a.ts', 'b.ts'] })])
      assert.ok(md.includes('**Files read:**'))
      assert.ok(md.includes('- `a.ts`'))
      assert.ok(md.includes('(log file)'))
    })

    test('omits the files read section when empty', () => {
      const md = toMarkdown([makeSession({ filesRead: [] })])
      assert.ok(!md.includes('**Files read:**'))
    })
  })

  suite('serializeExport', () => {
    test('json format matches JSON.stringify with 2-space indent', () => {
      const sessions = [makeSession()]
      assert.strictEqual(serializeExport(sessions, 'json'), JSON.stringify(sessions, null, 2))
    })

    test('csv format delegates to toCsv', () => {
      const sessions = [makeSession()]
      assert.strictEqual(serializeExport(sessions, 'csv'), toCsv(sessions))
    })

    test('markdown format delegates to toMarkdown', () => {
      // toMarkdown embeds the current timestamp, so two independent calls can differ by a few ms —
      // strip the timestamp before comparing rather than asserting exact string equality.
      const stripTimestamp = (s: string) => s.replace(/exported \S+/, 'exported <ts>')
      const sessions = [makeSession()]
      assert.strictEqual(stripTimestamp(serializeExport(sessions, 'markdown')), stripTimestamp(toMarkdown(sessions)))
    })
  })
})
