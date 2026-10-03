import * as assert from 'assert'
import { computeEditStats, countLines, lineDiff, editStatsFromRecord } from '../editStats'
import { parseApplyPatchEditDetails } from '../summarizers/helpers'

type Entry = { type: string; editDetails?: Array<{ filePath?: string; oldString?: string; newString?: string; content?: string; toolName?: string }> }

suite('editStats — agent-authored change size', () => {
  test('countLines ignores a trailing newline', () => {
    assert.strictEqual(countLines(''), 0)
    assert.strictEqual(countLines(undefined), 0)
    assert.strictEqual(countLines('a'), 1)
    assert.strictEqual(countLines('a\nb\n'), 2)
  })

  test('lineDiff trims common lines and LCS-diffs the middle', () => {
    assert.deepStrictEqual(lineDiff('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 })
    assert.deepStrictEqual(lineDiff('a\nc', 'a\nb\nc'), { added: 1, removed: 0 })
    assert.deepStrictEqual(lineDiff('x\ny\nz', 'y'), { added: 0, removed: 2 })
    // Middle reordered: LCS keeps the shared line.
    assert.deepStrictEqual(lineDiff('1\nk\n2', '3\nk\n4'), { added: 2, removed: 2 })
  })

  test('a multi-edit session sums every edit', () => {
    const timeline: Entry[] = [
      { type: 'tool', editDetails: [{ filePath: '/r/a.ts', toolName: 'Edit', oldString: 'const x = 1', newString: 'const x = 2\nconst y = 3' }] },
      { type: 'tool', editDetails: [{ filePath: '/r/a.ts', toolName: 'Edit', oldString: 'old1\nold2\nkeep', newString: 'keep' }] },
      { type: 'tool', editDetails: [{ filePath: '/r/README.md', toolName: 'Edit', oldString: '# T', newString: '# Title' }] },
    ]
    assert.deepStrictEqual(computeEditStats({ filesChanged: ['/r/a.ts', '/r/README.md'], timeline }),
      { filesChangedCount: 2, linesAdded: 3, linesRemoved: 4 })
  })

  test('a new-file Write counts every content line as added', () => {
    const timeline: Entry[] = [{ type: 'tool', editDetails: [{ filePath: '/r/new.py', toolName: 'Write', content: 'a\nb\nc\n' }] }]
    assert.deepStrictEqual(computeEditStats({ filesChanged: ['/r/new.py'], timeline }),
      { filesChangedCount: 1, linesAdded: 3, linesRemoved: 0 })
  })

  test('apply_patch hunks count their - and + lines as stated', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/a.ts',
      '@@',
      ' context',
      '-old one',
      '-}',
      '+new one',
      '+}',
      '+extra',
      '*** Add File: src/b.ts',
      '+line 1',
      '+line 2',
      '*** End Patch',
    ].join('\n')
    const details = parseApplyPatchEditDetails(patch)
    assert.deepStrictEqual(details.map(d => d.filePath), ['src/a.ts', 'src/b.ts'])
    assert.deepStrictEqual(computeEditStats({ filesChanged: ['src/a.ts', 'src/b.ts'], timeline: [{ type: 'tool', editDetails: details }] }),
      { filesChangedCount: 2, linesAdded: 5, linesRemoved: 2 })
  })

  test('LLM-entry details win over tool-entry duplicates of the same edit', () => {
    const d = { filePath: '/r/a.ts', toolName: 'Edit', oldString: 'a', newString: 'b' }
    assert.deepStrictEqual(computeEditStats({ filesChanged: ['/r/a.ts'], timeline: [{ type: 'llm', editDetails: [d] }, { type: 'tool', editDetails: [d] }] }),
      { filesChangedCount: 1, linesAdded: 1, linesRemoved: 1 })
  })

  test('files changed with no edit details → lines unknown; nothing changed → 0/0', () => {
    assert.deepStrictEqual(computeEditStats({ filesChanged: ['/r/a.ts', '/r/a.ts', '/r/b.json'], timeline: [] }), { filesChangedCount: 2 })
    assert.deepStrictEqual(computeEditStats({ filesChanged: [], timeline: [] }), { filesChangedCount: 0, linesAdded: 0, linesRemoved: 0 })
  })

  test('editStatsFromRecord accepts only non-negative integers', () => {
    assert.deepStrictEqual(editStatsFromRecord({ linesAdded: 4, linesRemoved: -1, filesChangedCount: 'x' }, ['a', 'b']),
      { filesChangedCount: 2, linesAdded: 4 })
  })
})
