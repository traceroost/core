import * as vscode from 'vscode'
import { Span, SpanAttribute } from './types'
import { summarizeSpans } from './spanSummarizer'

export async function exportSpans(spans: Span[], baseUri: vscode.Uri, prefix = 'export'): Promise<string[]> {
  const sessions = summarizeSpans(spans).sessions
  const traceAgent: Record<string, string> = {}
  for (const session of sessions) {
    const agent = session.source === 'claude_code' ? 'claude' : session.source
    traceAgent[session.traceId] = agent
  }

  const groups: Record<string, Span[]> = {}
  for (const span of spans) {
    const agent = traceAgent[span.traceId]
    if (!agent) { continue }
    const attrs: SpanAttribute[] = Array.isArray(span.attributes) ? span.attributes : []
    const rawPath = attrs.find((a: SpanAttribute) => a.key === '_traceroost.collector_path')?.value?.stringValue || ''
    const endpoint = rawPath ? rawPath.replace(/^\//, '').replace(/\//g, '-') : 'main'
    const key = `${endpoint}__${agent}`
    if (!groups[key]) { groups[key] = [] }
    groups[key].push(span)
  }

  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

  const writtenFiles: string[] = []
  for (const [key, groupSpans] of Object.entries(groups)) {
    const parts = key.split('__')
    const endpoint = parts[0] || 'main'
    const agent = parts[1] || 'unknown'
    const filename = `${prefix}_${agent}_${endpoint}_${timestamp}.json`
    const uri = vscode.Uri.joinPath(baseUri, filename)
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(groupSpans, null, 2)))
    writtenFiles.push(filename)
  }

  return writtenFiles
}

// Keys whose values contain prompt/completion content
const CONTENT_KEYS = new Set([
  'gen_ai.prompt', 'gen_ai.completion',
  'llm.prompts', 'llm.completions',
  'tool_input', 'tool_result',
  'user_prompt', 'system_prompt',
  'input', 'output',
])

// Keys whose values contain personal/org identity
const PII_KEYS = new Set([
  'user.id', 'user.name', 'user.email', 'user.username',
  'enduser.id', 'enduser.name', 'enduser.email',
  'organization.id', 'organization.name',
  'github.copilot.user', 'github.user',
])

function shouldRedact(key: string): boolean {
  if (CONTENT_KEYS.has(key)) { return true }
  if (PII_KEYS.has(key)) { return true }
  if (key.endsWith('.content')) { return true }
  // pattern matches for content
  if (key.includes('prompt') || key.includes('tool_input') || key.includes('tool_result')) { return true }
  // pattern matches for PII
  if (key.startsWith('user.') || key.startsWith('enduser.') || key.startsWith('organization.')) { return true }
  return false
}

function redactSpan(span: Span): Span {
  const attrs = Array.isArray(span.attributes) ? span.attributes : []
  return {
    ...span,
    attributes: attrs.map((a: SpanAttribute) =>
      shouldRedact(a.key) ? { key: a.key, value: { stringValue: '[redacted]' } } : a
    ),
  }
}

export async function exportSpansRedacted(spans: Span[], baseUri: vscode.Uri): Promise<string[]> {
  return exportSpans(spans.map(redactSpan), baseUri, 'export_redacted')
}
