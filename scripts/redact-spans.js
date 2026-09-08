#!/usr/bin/env node
/**
 * Redacts personal data from TraceRoost span exports before sharing in a GitHub issue.
 *
 * What is redacted:
 *   - user.email, user.id, user.account_id, user.account_uuid   → [REDACTED_*]
 *   - session.id, organization.id                                → [REDACTED_*]
 *   - Home directory paths (/Users/<name>/, /home/<name>/, C:\Users\<name>\) → [USER]
 *   - Email addresses found anywhere in string values            → [REDACTED_EMAIL]
 *   --redact-content: also strips prompt text and tool call arguments / results
 *
 * Usage:
 *   node scripts/redact-spans.js
 *   node scripts/redact-spans.js --input /path/to/spans.json --output redacted.json
 *   node scripts/redact-spans.js --redact-content
 */

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// ── CLI args ──────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2)
const inputIdx       = args.indexOf('--input')
const outputIdx      = args.indexOf('--output')
const redactContent  = args.includes('--redact-content')

const inputFile  = inputIdx  >= 0 ? args[inputIdx  + 1] : path.join(os.homedir(), '.traceroost', 'spans.json')
const outputFile = outputIdx >= 0 ? args[outputIdx + 1] : null

// ── Redaction config ──────────────────────────────────────────────────────────

// These attribute keys have their entire value replaced with a placeholder.
const PII_KEYS = new Set([
  // Claude Code / Codex
  'user.email',
  'user.id',
  'user.account_id',
  'user.account_uuid',
  'session.id',
  'organization.id',
  // Copilot
  'copilot_chat.session_id',
  'copilot_chat.chat_session_id',
  'copilot_chat.server_request_id',
  'gen_ai.conversation.id',
  'gen_ai.response.id',
  // Repo identifiers (may identify private repos)
  'copilot_chat.repo.head_commit_hash',
  'copilot_chat.repo.head_branch_name',
])

// These keys contain rich text (prompts, file content, tool args) and are only
// redacted when --redact-content is passed.
const CONTENT_KEYS = new Set([
  'user_prompt',
  'copilot_chat.user_request',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.output.messages',
  'gen_ai.input.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'full_command',
])

// Patterns applied to every remaining string value
const EMAIL_RE    = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const UNIX_HOME_RE = /(\/(Users|home)\/)([^/\s"'\\,]+)/g   // /Users/<name>  /home/<name>
const WIN_HOME_RE  = /([A-Z]:\\Users\\)([^\\\/\s"',]+)/gi  // C:\Users\<name>

function redactString(s) {
  s = s.replace(UNIX_HOME_RE, (_, prefix, __, _name) => prefix + '[USER]')
  s = s.replace(WIN_HOME_RE,  (_, prefix, _name)      => prefix + '[USER]')
  s = s.replace(EMAIL_RE, '[REDACTED_EMAIL]')
  return s
}

function redactSpan(span) {
  if (!Array.isArray(span.attributes)) return span

  const attributes = span.attributes.map(attr => {
    const sv = attr.value?.stringValue
    if (typeof sv !== 'string') return attr

    const key = attr.key

    if (PII_KEYS.has(key)) {
      const label = key.toUpperCase().replace(/\./g, '_')
      return { ...attr, value: { stringValue: `[REDACTED_${label}]` } }
    }

    if (redactContent && CONTENT_KEYS.has(key)) {
      return { ...attr, value: { stringValue: '[REDACTED_CONTENT]' } }
    }

    const cleaned = redactString(sv)
    return cleaned === sv ? attr : { ...attr, value: { stringValue: cleaned } }
  })

  return { ...span, attributes }
}

// ── Main ──────────────────────────────────────────────────────────────────────

let raw
try {
  raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'))
} catch (e) {
  console.error(`Cannot read ${inputFile}: ${e.message}`)
  process.exit(1)
}

// Accept both a bare span array (spans.json) and the fixture format { spans: [...], ... }
const isFixture = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.spans)
const spans     = isFixture ? raw.spans : raw

if (!Array.isArray(spans)) {
  console.error('Expected a JSON array of spans, or a fixture object with a "spans" array.')
  process.exit(1)
}

const redactedSpans = spans.map(redactSpan)
const result        = isFixture ? { ...raw, spans: redactedSpans } : redactedSpans
const out           = JSON.stringify(result, null, 2)

if (outputFile) {
  fs.writeFileSync(outputFile, out)
  const note = redactContent ? ' (including prompt/tool content)' : ''
  console.error(`Redacted ${spans.length} spans → ${outputFile}${note}`)
  if (!redactContent) {
    console.error('Tip: re-run with --redact-content to also strip prompt text and tool arguments.')
  }
} else {
  process.stdout.write(out)
}
