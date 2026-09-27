type Row = Record<string, unknown>;

/** Select whole cumulative usage snapshots; never discard content blocks.
 * Claude output grows within a request. Prefer the greatest output snapshot,
 * and the later record on ties. Missing IDs stay independent. Conflicting
 * non-monotonic producer formats are outside this reconciliation contract.
 */
export function claudeUsageLines(lines: string[]): Set<number> {
  return claudeUsageRows(lines.map(line => {
    try { return JSON.parse(line) as unknown } catch { return undefined }
  }))
}

/** claudeUsageLines() over lines the caller already parsed: `rows[i]` is line i's JSON.parse
 *  result, or undefined when it didn't parse. */
export function claudeUsageRows(rows: unknown[]): Set<number> {
  const selected = new Map<string, { index: number; output: number }>()
  const result = new Set<number>()
  rows.forEach((parsed, index) => {
    if (parsed === undefined) return
    const row = parsed as Row
    if (!row || row.type !== 'assistant') return
    const msg = row.message as Row | undefined
    const usage = msg?.usage as Row | undefined
    if (!usage) return
    const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    if (typeof msg?.id !== 'string' || !msg.id) { result.add(index); return }
    const key = JSON.stringify([row.sessionId ?? row.session_id ?? '', row.requestId ?? '', msg.id])
    const previous = selected.get(key)
    if (!previous || output >= previous.output) {
      if (previous) result.delete(previous.index)
      selected.set(key, { index, output })
      result.add(index)
    }
  })
  return result
}
