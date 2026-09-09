/**
 * Instruction file detection and I/O for the Instruction Advisor feature.
 * Reads and writes CLAUDE.md, .github/copilot-instructions.md, and AGENTS.md.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface InstructionFileStatus {
  agent: 'claude_code' | 'copilot' | 'codex'
  label: string
  filePath: string        // absolute path
  relativePath: string    // relative to workspace root
  exists: boolean
  content: string         // empty string if file doesn't exist
}

const INSTRUCTION_FILE_DEFS: Array<{
  agent: InstructionFileStatus['agent']
  label: string
  relative: string
  alternates?: string[]
}> = [
  { agent: 'claude_code', label: 'Claude Code',    relative: 'CLAUDE.md',                            alternates: ['.claude/CLAUDE.md'] },
  { agent: 'copilot',     label: 'GitHub Copilot', relative: '.github/copilot-instructions.md' },
  { agent: 'codex',       label: 'Codex',          relative: 'AGENTS.md' },
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
      label: def.label,
      filePath: path.join(workspaceRoot, def.relative),
      relativePath: def.relative,
      exists: false,
      content: '',
    }
  })
}

/** Append a suggestion block to an instruction file. Creates the file (and directory) if it doesn't exist. */
export function appendSuggestion(filePath: string, text: string, label: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const marker = `<!-- TraceRoost suggestion applied ${new Date().toISOString().slice(0, 10)} id:${label} -->`
  const block = `\n\n${marker}\n${text}\n`
  fs.appendFileSync(filePath, block, 'utf8')
}

/** Remove a previously applied suggestion block by its label. */
export function removeSuggestion(filePath: string, label: string): boolean {
  if (!fs.existsSync(filePath)) return false
  let content: string
  try { content = fs.readFileSync(filePath, 'utf8') } catch { return false }

  // Match the comment marker line + everything until (not including) the next marker or EOF
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\n\\n<!-- TraceRoost suggestion applied [\\d-]+ id:${escaped} -->\\n[\\s\\S]*?(?=\\n\\n<!-- TraceRoost|$)`, 'g')
  const updated = content.replace(re, '')
  if (updated === content) return false
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
