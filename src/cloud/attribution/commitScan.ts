/**
 * Walks `git log` for a repository and a time window, returning commits with per-file line
 * counts (AL 05).
 *
 * Commit messages are read only to detect an agent trailer — they are never stored, hashed into
 * anything reversible, or transmitted. Only the resulting boolean leaves this step.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ScannedCommit } from './types'

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 20_000

// Trailers / co-authors that name an AI agent — deliberately conservative, a false "certain" is
// worse than a missed one. A trailer counts only in a known agent form (by the email or bot login
// the agent itself writes), never because a co-author's name merely contains "claude" or
// "copilot": `Co-authored-by: Claude Dupont <claude@example.com>` is a person.
const AGENT_TRAILER_LINE_RE = /^[ \t]*(?:co-authored-by|assisted-by|generated-by)[ \t]*:[ \t]*(.+)$/gim
const AGENT_TRAILER_VALUE_RES: RegExp[] = [
  /<noreply@anthropic\.com>/i,                                                // Claude Code: Claude <noreply@anthropic.com>
  /^claude (?:code|opus|sonnet|haiku|fable|mythos)\b[^<]*<[^>]+>/i,            // Claude Opus 4.5 <…>, Claude Sonnet 4 <…>
  /<(?:\d+\+)?copilot@users\.noreply\.github\.com>/i,                          // GitHub Copilot coding agent
  /copilot-swe-agent\[bot\]/i,
  /chatgpt-codex-connector\[bot\]|<[^>]*codex[^>]*@openai\.com>|<noreply@openai\.com>/i, // OpenAI Codex
  /<cursoragent@cursor\.com>/i,                                                // Cursor background agent
  /<noreply@aider\.chat>/i,                                                    // aider
  /devin-ai-integration\[bot\]/i,                                             // Devin
  /gemini-code-assist\[bot\]|google-labs-jules\[bot\]/i,                        // Gemini / Jules
]
const AGENT_GENERATED_RE = /🤖\s*generated with|generated with \[?claude code\]?/i

export function hasAgentTrailer(message: string): boolean {
  if (AGENT_GENERATED_RE.test(message)) return true
  for (const m of message.matchAll(AGENT_TRAILER_LINE_RE)) {
    const value = m[1].trim()
    if (AGENT_TRAILER_VALUE_RES.some(re => re.test(value))) return true
  }
  return false
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 })
    return stdout
  } catch {
    return null
  }
}

/**
 * `sinceIso` bounds the walk (default: everything). Returns commits newest-first. A commit's
 * message is fetched with a separate `%B` field and inspected for a trailer, then discarded.
 */
export async function scanCommits(repoRoot: string, opts: { sinceIso?: string; maxCommits?: number } = {}): Promise<ScannedCommit[]> {
  const args = [
    'log',
    '--no-color',
    '--numstat',
    '--date=iso-strict',
    // Record separator + field format. %x1e between commits, %x1f between fields.
    '--pretty=format:%x1e%H%x1f%aI%x1f%ae%x1f%P%x1f%B%x1f',
  ]
  if (opts.sinceIso) args.push(`--since=${opts.sinceIso}`)
  if (opts.maxCommits) args.push(`-n${opts.maxCommits}`)

  const out = await git(repoRoot, args)
  if (out === null) return []

  const commits: ScannedCommit[] = []
  for (const block of out.split('\x1e')) {
    if (!block.trim()) continue
    // Fields are \x1f-separated: sha, authoredAt, authorEmail, parents, message, then the
    // numstat block. The message can contain newlines but never \x1f (a control char).
    const parts = block.split('\x1f')
    if (parts.length < 6) continue
    const sha = parts[0].replace(/^\n/, '').trim()
    const authoredAt = parts[1].trim()
    const authorEmail = parts[2].trim()
    const parents = parts[3].trim().split(/\s+/).filter(Boolean)
    const message = parts[4]
    const numstat = parts.slice(5).join('\x1f')

    const files: ScannedCommit['files'] = {}
    let linesAdded = 0
    let linesRemoved = 0
    for (const line of numstat.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      const added = m[1] === '-' ? 0 : parseInt(m[1], 10)
      const removed = m[2] === '-' ? 0 : parseInt(m[2], 10)
      const rawPath = m[3]
      // Rename form "old => new" or "dir/{old => new}/x" — take the new path.
      const path = normalizeRenamePath(rawPath)
      files[path] = { added: (files[path]?.added ?? 0) + added, removed: (files[path]?.removed ?? 0) + removed }
      linesAdded += added
      linesRemoved += removed
    }

    commits.push({
      sha,
      authoredAt,
      authorEmail,
      isMerge: parents.length > 1,
      subjectHadAgentTrailer: hasAgentTrailer(message),
      files,
      linesAdded,
      linesRemoved,
    })
  }
  return commits
}

function normalizeRenamePath(p: string): string {
  // "src/{a => b}/x.ts" → "src/b/x.ts" ;  "a.ts => b.ts" → "b.ts"
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/{2,}/g, '/')
  const arrow = p.match(/^(.*) => (.*)$/)
  if (arrow) return arrow[2]
  return p
}

/** Whether a repository has enough history to attribute (not a shallow clone). */
export async function isShallow(repoRoot: string): Promise<boolean> {
  return (await git(repoRoot, ['rev-parse', '--is-shallow-repository']))?.trim() === 'true'
}

export async function repoRootOf(cwd: string): Promise<string | null> {
  return (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || null
}
