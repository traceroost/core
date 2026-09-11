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

// Trailers / co-authors that name an AI agent. Case-insensitive, matched against the full
// commit message. Deliberately conservative — a false "certain" is worse than a missed one.
const AGENT_TRAILER_RE =
  /(?:^|\n)\s*(?:co-authored-by|assisted-by|generated-by)\s*:\s*[^\n]*(claude|anthropic|copilot|github-actions\[bot\]|codex|openai|cursor|aider|devin|gemini)/i
const AGENT_GENERATED_RE = /🤖\s*generated with|generated with \[?claude code\]?|co-authored-by:\s*claude/i

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
      subjectHadAgentTrailer: AGENT_TRAILER_RE.test(message) || AGENT_GENERATED_RE.test(message),
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
