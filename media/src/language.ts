// Per-session programming language — the ONE definition of the language allowlist, the extension
// map and the derivation. Byte-for-byte identical copies live at src/language.ts (extension host:
// summarizers, database, export, cloud forwarding) and media/src/language.ts (the dashboard's
// Language column, filter and by-language cut). Neither tsconfig can import across that boundary
// (see media/src/signalFormulas.ts for why), so the file is copied, and src/test/language.test.ts
// fails if the two copies differ. Edit one, copy it over the other. Deliberately import-free.
//
// Language is a low-sensitivity, fixed-choice label like agent and model — never free text. It is
// one of LANGUAGE_IDS below, and that same list is the `language` enum in schema/rollup.v1.json
// (cloud validates against the same allowlist).
//
// How a session's language is derived (deriveSessionLanguage):
//  - Input is the file paths the agent's tool calls touched — the summarizers' filesRead and
//    filesChanged (filesWritten is a subset of filesChanged). Searched paths/globs are not used.
//  - Each DISTINCT file counts once per session, however many times it was read or edited — so
//    re-reading one file 50 times does not outweigh ten other files. Paths are compared with
//    `\` folded to `/`; a Windows drive path (`C:\…`) is also compared case-insensitively.
//  - Only code files count. A file's extension is matched case-insensitively against
//    EXTENSION_LANGUAGE (the allowlisted languages) and OTHER_CODE_EXTENSIONS (code outside the
//    allowlist, counted as `other`). Everything else is EXCLUDED: docs/data/config (.md .json
//    .yaml .yml .toml .ini .env .cfg .xml .lock .txt .csv, images, …), lockfiles
//    (package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, go.sum, Gemfile.lock,
//    poetry.lock, composer.lock), any dotfile (`.eslintrc.js`, `.env.local`), and any unknown
//    extension — unknown is excluded rather than `other`, so a session that only touched config
//    never reads as a "language".
//  - `language` is the language with the most distinct files; `none` when no code file was
//    touched. Ties break deterministically: more distinct files, then more distinct CHANGED files
//    (edited/written beats read-only), then LANGUAGE_IDS order.
//  - `languageSecondary` is the runner-up distinct language under the same ordering, or null when
//    only one language was touched. It is never `none`. `other` MAY be secondary (a TypeScript
//    session that also edited a shell script reads typescript + other), and may be primary.
//
// The session's change size (files changed, lines added/removed — src/editStats.ts) is the
// opposite on purpose: it counts EVERY file the agent edited or wrote, code or not. Language
// excludes non-code files; those counts don't.

export const LANGUAGE_IDS = [
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp',
  'ruby', 'php', 'swift', 'kotlin', 'other', 'none',
] as const

export type SessionLanguage = typeof LANGUAGE_IDS[number]
/** A language a code file can count toward — every id except `none`. Also the secondary's type. */
export type CodeLanguage = Exclude<SessionLanguage, 'none'>

export const LANGUAGE_LABELS: Record<SessionLanguage, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  csharp: 'C#',
  cpp: 'C/C++',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  other: 'Other code',
  none: 'No code',
}

/** Short form for compact table cells (the Traces table's Lang column) — standard abbreviations,
 *  the same mapping TraceRoost Cloud uses. Everywhere with room (the Language filter, a trace's
 *  detail tiles, the by-language table, Help) shows LANGUAGE_LABELS; a cell showing this keeps the
 *  full label in its title/aria-label. */
export const LANGUAGE_ABBREVIATIONS: Record<SessionLanguage, string> = {
  typescript: 'TS',
  javascript: 'JS',
  python: 'Py',
  go: 'Go',
  rust: 'Rust',
  java: 'Java',
  csharp: 'C#',
  cpp: 'C++',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kt',
  other: 'Other',
  none: 'None',
}

/** Extension (lower-case, with the dot) → allowlisted language. */
export const EXTENSION_LANGUAGE: Readonly<Record<string, CodeLanguage>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'csharp',
  '.c': 'cpp', '.h': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin',
}

/** Code outside the allowlist — counted as `other`. Deliberately a small explicit set: an
 *  extension in neither map is excluded, never guessed to be code. */
export const OTHER_CODE_EXTENSIONS: readonly string[] = [
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.scala', '.lua', '.dart', '.vue', '.svelte',
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.r', '.pl', '.ex', '.exs', '.erl',
  '.hs', '.clj', '.elm', '.zig', '.m', '.mm', '.fs', '.groovy', '.jl',
]

const OTHER_CODE_SET = new Set(OTHER_CODE_EXTENSIONS)

export function isSessionLanguage(v: unknown): v is SessionLanguage {
  return typeof v === 'string' && (LANGUAGE_IDS as readonly string[]).includes(v)
}

export function isCodeLanguage(v: unknown): v is CodeLanguage {
  return isSessionLanguage(v) && v !== 'none'
}

/** The language one path counts toward, or null when it is not a code file (excluded). */
export function languageForPath(filePath: string): CodeLanguage | null {
  if (typeof filePath !== 'string' || filePath === '') return null
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = filePath.slice(slash + 1)
  // Dotfiles (.eslintrc.js, .env.local, .gitignore) are config, whatever their extension.
  if (base === '' || base.startsWith('.')) return null
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = base.slice(dot).toLowerCase()
  const lang = EXTENSION_LANGUAGE[ext]
  if (lang) return lang
  return OTHER_CODE_SET.has(ext) ? 'other' : null
}

function fileKey(filePath: string): string {
  const p = filePath.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p
}

export interface SessionLanguageResult {
  language: SessionLanguage
  languageSecondary: CodeLanguage | null
}

/** Derives a session's primary and secondary language from the files it read and changed. */
export function deriveSessionLanguage(files: {
  filesRead?: readonly string[]
  filesChanged?: readonly string[]
  filesWritten?: readonly string[]
}): SessionLanguageResult {
  // Distinct file → (language, was it changed). A file both read and changed counts once, as changed.
  const seen = new Map<string, { lang: CodeLanguage; changed: boolean }>()
  const add = (paths: readonly string[] | undefined, changed: boolean) => {
    for (const p of paths ?? []) {
      const lang = languageForPath(p)
      if (!lang) continue
      const key = fileKey(p)
      const prev = seen.get(key)
      if (prev) prev.changed = prev.changed || changed
      else seen.set(key, { lang, changed })
    }
  }
  add(files.filesChanged, true)
  add(files.filesWritten, true)
  add(files.filesRead, false)

  const tally = new Map<CodeLanguage, { files: number; changed: number }>()
  for (const { lang, changed } of seen.values()) {
    const t = tally.get(lang) ?? { files: 0, changed: 0 }
    t.files++
    if (changed) t.changed++
    tally.set(lang, t)
  }
  const ranked = [...tally.entries()].sort((a, b) =>
    (b[1].files - a[1].files)
    || (b[1].changed - a[1].changed)
    || (LANGUAGE_IDS.indexOf(a[0]) - LANGUAGE_IDS.indexOf(b[0])))
  return {
    language: ranked[0]?.[0] ?? 'none',
    languageSecondary: ranked[1]?.[0] ?? null,
  }
}

/** The language pair for a session card rebuilt from untrusted JSON (an Import): the record's own
 *  `language`/`languageSecondary` when they are valid allowlisted ids, otherwise re-derived from
 *  its file lists. Never passes an unrecognised string through. */
export function languageFromRecord(
  raw: { language?: unknown; languageSecondary?: unknown },
  files: { filesRead?: readonly string[]; filesChanged?: readonly string[] },
): SessionLanguageResult {
  if (isSessionLanguage(raw.language)) {
    const secondary = isCodeLanguage(raw.languageSecondary) && raw.languageSecondary !== raw.language ? raw.languageSecondary : null
    return { language: raw.language, languageSecondary: raw.language === 'none' ? null : secondary }
  }
  return deriveSessionLanguage(files)
}

/** Display label for a stored language — "—" when unknown (a row stored before this existed). */
export function languageLabel(lang: string | null | undefined): string {
  return isSessionLanguage(lang) ? LANGUAGE_LABELS[lang] : '—'
}

/** Compact-cell label for a stored language (LANGUAGE_ABBREVIATIONS) — "—" when unknown. */
export function languageAbbreviation(lang: string | null | undefined): string {
  return isSessionLanguage(lang) ? LANGUAGE_ABBREVIATIONS[lang] : '—'
}
