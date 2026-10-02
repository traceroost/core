/**
 * Instruction file detection and I/O for the Instruction Advisor feature.
 * Reads and writes CLAUDE.md, .github/copilot-instructions.md, AGENTS.md and a Cursor project rule.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface InstructionFileStatus {
  /** The agent this file is listed under (its primary reader). */
  agent: 'claude_code' | 'copilot' | 'codex' | 'cursor'
  /** Every agent that reads the file — AGENTS.md is shared by Codex, OpenCode and the Cursor CLI. */
  agents: Array<'claude_code' | 'copilot' | 'codex' | 'opencode' | 'cursor'>
  label: string
  filePath: string        // absolute path
  relativePath: string    // relative to workspace root
  exists: boolean
  content: string         // empty string if file doesn't exist
}

/** Cursor's project rule TraceRoost writes into. Cursor reads `.cursor/rules/*.mdc` (and the Cursor
 *  CLI also AGENTS.md); an .mdc rule only loads into every chat with `alwaysApply: true` in its
 *  frontmatter, so TraceRoost keeps its own always-applied rule rather than appending to a user's
 *  rule that may be scoped to some globs. */
export const CURSOR_RULE_FILE = '.cursor/rules/traceroost.mdc'

const CURSOR_RULE_FRONTMATTER =
  '---\ndescription: Project guidance added from TraceRoost instruction suggestions\nalwaysApply: true\n---\n'

const INSTRUCTION_FILE_DEFS: Array<{
  agent: InstructionFileStatus['agent']
  agents: InstructionFileStatus['agents']
  label: string
  relative: string
  alternates?: string[]
}> = [
  { agent: 'claude_code', agents: ['claude_code'], label: 'Claude Code', relative: 'CLAUDE.md', alternates: ['.claude/CLAUDE.md'] },
  { agent: 'copilot', agents: ['copilot'], label: 'GitHub Copilot', relative: '.github/copilot-instructions.md' },
  // One file, three readers: listed once so the picker doesn't offer AGENTS.md twice.
  { agent: 'codex', agents: ['codex', 'opencode', 'cursor'], label: 'Codex · OpenCode', relative: 'AGENTS.md' },
  { agent: 'cursor', agents: ['cursor'], label: 'Cursor', relative: CURSOR_RULE_FILE },
]

export function detectInstructionFiles(workspaceRoot: string): InstructionFileStatus[] {
  return INSTRUCTION_FILE_DEFS.map(def => {
    // Check primary path first, then alternates
    const candidates = [def.relative, ...(def.alternates ?? [])]
    for (const rel of candidates) {
      const abs = path.join(workspaceRoot, rel)
      if (fs.existsSync(abs)) {
        let content = ''
        try { content = fs.readFileSync(abs, 'utf8') } catch { /* ignore */ }
        return {
          agent: def.agent,
          agents: def.agents,
          label: def.label,
          filePath: abs,
          relativePath: rel,
          exists: true,
          content,
        }
      }
    }
    // Primary path doesn't exist — return status for the primary (for create affordance)
    return {
      agent: def.agent,
      agents: def.agents,
      label: def.label,
      filePath: path.join(workspaceRoot, def.relative),
      relativePath: def.relative,
      exists: false,
      content: '',
    }
  })
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function endMarkerFor(label: string): string {
  return `<!-- /TraceRoost suggestion id:${label} -->`
}

/** Append a suggestion block to an instruction file. Creates the file (and directory) if it doesn't exist
 *  — a new Cursor `.mdc` rule starting with the frontmatter that makes Cursor always apply it. The block is bracketed by a start marker and an explicit end marker, so removeSuggestion can take
 *  out exactly this block and never anything the user wrote after it. */
export function appendSuggestion(filePath: string, text: string, label: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const marker = `<!-- TraceRoost suggestion applied ${new Date().toISOString().slice(0, 10)} id:${label} -->`
  const block = `\n\n${marker}\n${text}\n${endMarkerFor(label)}\n`
  const header = filePath.endsWith('.mdc') && !fs.existsSync(filePath) ? CURSOR_RULE_FRONTMATTER : ''
  fs.appendFileSync(filePath, header + block, 'utf8')
}

/**
 * Remove a previously applied suggestion block by its label. Only ever removes the block itself:
 * - Blocks written with an end marker: start marker through end marker, inclusive.
 * - Legacy blocks (no end marker): the start marker plus `appliedText`, and only when the text right
 *   after the marker is still exactly `appliedText`. If it isn't (the user edited it) or the caller
 *   doesn't know it, the file is left untouched — guessing where a legacy block ends is what used to
 *   delete user text written below it.
 */
export function removeSuggestion(filePath: string, label: string, appliedText?: string): boolean {
  if (!fs.existsSync(filePath)) return false
  let content: string
  try { content = fs.readFileSync(filePath, 'utf8') } catch { return false }

  const startRe = new RegExp(`(?:\\n\\n)?<!-- TraceRoost suggestion applied [\\d-]+ id:${escapeRe(label)} -->\\n`)
  const start = startRe.exec(content)
  if (!start) return false
  const bodyStart = start.index + start[0].length

  let end = -1
  const endMarker = endMarkerFor(label)
  const endIdx = content.indexOf(endMarker, bodyStart)
  if (endIdx !== -1) {
    end = endIdx + endMarker.length
  } else if (appliedText !== undefined && content.startsWith(appliedText, bodyStart)) {
    end = bodyStart + appliedText.length
  }
  if (end === -1) return false
  // Consume the block's trailing newline too — unless text follows and removing it would glue
  // that text onto the end of the line before the block.
  if (content[end] === '\n') {
    const gluesLines = end + 1 < content.length && start.index > 0 && content[start.index - 1] !== '\n'
    if (!gluesLines) end++
  }

  const updated = content.slice(0, start.index) + content.slice(end)
  fs.writeFileSync(filePath, updated, 'utf8')
  return true
}

/** Concatenate the content of all detected instruction files in a workspace. */
export function readAllInstructionContent(workspaceRoot: string): string {
  const files = detectInstructionFiles(workspaceRoot)
  return files
    .filter(f => f.exists)
    .map(f => f.content)
    .join('\n')
}
