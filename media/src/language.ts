// Per-session programming language — the ONE definition of the language allowlist, the extension
// map and the derivation. Byte-for-byte identical copies live at src/language.ts (extension host:
// summarizers, database, export, cloud forwarding) and media/src/language.ts (the dashboard's
// Language column, filter and by-language cut). Neither tsconfig can import across that boundary
// (see media/src/signalFormulas.ts for why), so the file is copied, and src/test/language.test.ts
// fails if the two copies differ. Edit one, copy it over the other. Deliberately import-free.
//
// Language is a low-sensitivity, fixed-choice label like agent and model — never free text (for a
// session with no code it names a kind of file instead — docs, config, …). It is one of
// LANGUAGE_IDS below, and that same list is the `language` enum in schema/rollup.v1.json
// (cloud validates against the same allowlist).
//
// How a session's language is derived (deriveSessionLanguage):
//  - Input is the file paths the agent's tool calls touched — the summarizers' filesRead and
//    filesChanged (filesWritten is a subset of filesChanged). Searched paths/globs are not used.
//  - Each DISTINCT file counts once per session, however many times it was read or edited — so
//    re-reading one file 50 times does not outweigh ten other files. Paths are compared with
//    `\` folded to `/`; a Windows drive path (`C:\…`) is also compared case-insensitively.
//  - Code files decide the language. A file's extension is matched case-insensitively against
//    EXTENSION_LANGUAGE (the allowlisted languages) and OTHER_CODE_EXTENSIONS (code outside the
//    allowlist, counted as `other`).
//  - Vue and Svelte single-file components (.vue, .svelte) have no id of their own: their script
//    is TypeScript or JavaScript. Only paths are available here (never file contents, so a
//    component's `lang="ts"` can't be read), so a component counts as `typescript` when the same
//    session touched any TypeScript file (.ts .tsx .mts .cts), otherwise as `javascript`.
//    languageForPath, which sees one path alone, reports a component as `javascript`.
//  - `language` is the code language with the most distinct files. Ties break deterministically:
//    more distinct files, then more distinct CHANGED files (edited/written beats read-only), then
//    LANGUAGE_IDS order. `languageSecondary` is the runner-up under the same ordering, or null
//    when only one was touched. `other` MAY be secondary (a TypeScript session that also edited a
//    Lua script reads typescript + other), and may be primary.
//  - Only when the session touched NO code file does a non-code category decide it, ranked the
//    same way: `docs` (.md .txt .rst …, README/LICENSE), `config` (.json .yaml .toml .ini .env
//    .xml, lockfiles, dotfiles, Dockerfile/Makefile …), `data` (.csv .tsv .jsonl .parquet,
//    spreadsheets …) or `assets` (images, fonts, audio/video). Code always wins: a TypeScript
//    session that also edited the README reads typescript, never docs, and a code primary never
//    has a non-code secondary (nor the other way round).
//  - `none` ("No code") — files were touched, but none in any category (an unknown extension:
//    unknown is never guessed to be code). `no_files` — no file path was touched at all, as in a
//    Codex or Copilot Chat log, which records none. Neither is ever secondary.
//  - Before the non-code categories existed, every non-code session was stored as `none`; a
//    stored `none` is re-derived from its file lists when read back (languageFromRecord).
//
// The session's change size (files changed, lines added/removed — src/editStats.ts) is
// independent of this: it counts EVERY file the agent edited or wrote, code or not.

export const LANGUAGE_IDS = [
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'csharp', 'cpp',
  'ruby', 'php', 'swift', 'kotlin', 'dart', 'shell', 'sql', 'html', 'css', 'other',
  'docs', 'config', 'data', 'assets', 'none', 'no_files',
] as const

export type SessionLanguage = typeof LANGUAGE_IDS[number]
/** The categories a session with no code file falls into, ranked like languages. */
export const NON_CODE_CATEGORIES = ['docs', 'config', 'data', 'assets'] as const
export type NonCodeCategory = typeof NON_CODE_CATEGORIES[number]
/** A language a code file can count toward. */
export type CodeLanguage = Exclude<SessionLanguage, NonCodeCategory | 'none' | 'no_files'>
/** What a secondary can be — any id except `none` and `no_files`, in the primary's own tier. */
export type SecondaryLanguage = CodeLanguage | NonCodeCategory

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
  dart: 'Dart',
  shell: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  other: 'Other code',
  docs: 'Docs',
  config: 'Config',
  data: 'Data',
  assets: 'Assets',
  none: 'No code',
  no_files: 'No files',
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
  dart: 'Dart',
  shell: 'Sh',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  other: 'Other',
  docs: 'Docs',
  config: 'Cfg',
  data: 'Data',
  assets: 'Asset',
  none: 'None',
  no_files: 'Nil',
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
  '.dart': 'dart',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.sql': 'sql',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
}

/** Vue/Svelte single-file components — TypeScript or JavaScript depending on the rest of the
 *  session (see the header comment), never an id of their own. */
export const COMPONENT_EXTENSIONS: readonly string[] = ['.vue', '.svelte']

/** Code outside the allowlist — counted as `other`. Deliberately a small explicit set: an
 *  extension in no map here is `none`, never guessed to be code. */
export const OTHER_CODE_EXTENSIONS: readonly string[] = [
  '.ps1', '.scala', '.lua', '.r', '.pl', '.ex', '.exs', '.erl',
  '.hs', '.clj', '.elm', '.zig', '.m', '.mm', '.fs', '.groovy', '.jl',
]

/** Extension (lower-case, with the dot) → non-code category. Only consulted for a session that
 *  touched no code file. */
export const EXTENSION_CATEGORY: Readonly<Record<string, NonCodeCategory>> = {
  ...Object.fromEntries(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc', '.asciidoc', '.org', '.tex',
    '.rtf', '.pdf', '.doc', '.docx', '.odt'].map(e => [e, 'docs' as const])),
  ...Object.fromEntries(['.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.env', '.properties', '.xml', '.plist', '.lock', '.tf', '.tfvars', '.hcl'].map(e => [e, 'config' as const])),
  ...Object.fromEntries(['.csv', '.tsv', '.jsonl', '.ndjson', '.parquet', '.avro', '.xlsx', '.xls', '.ods',
    '.sqlite', '.sqlite3', '.db'].map(e => [e, 'data' as const])),
  ...Object.fromEntries(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tif', '.tiff',
    '.avif', '.mp4', '.mov', '.webm', '.mp3', '.wav', '.ogg', '.woff', '.woff2', '.ttf', '.otf',
    '.eot'].map(e => [e, 'assets' as const])),
}

/** Well-known extensionless (or name-identified) files, by lower-case base name. Dotfiles are
 *  always `config` and are not listed. */
export const NAME_CATEGORY: Readonly<Record<string, NonCodeCategory>> = {
  'readme': 'docs', 'license': 'docs', 'licence': 'docs', 'changelog': 'docs', 'authors': 'docs',
  'notice': 'docs', 'contributing': 'docs', 'codeowners': 'docs',
  'dockerfile': 'config', 'makefile': 'config', 'procfile': 'config', 'jenkinsfile': 'config',
  'gemfile': 'config', 'podfile': 'config', 'brewfile': 'config', 'vagrantfile': 'config',
  'go.mod': 'config', 'go.sum': 'config', 'containerfile': 'config',
}

const OTHER_CODE_SET = new Set(OTHER_CODE_EXTENSIONS)
const COMPONENT_SET = new Set(COMPONENT_EXTENSIONS)
const NON_CODE_SET = new Set<string>(NON_CODE_CATEGORIES)

export function isSessionLanguage(v: unknown): v is SessionLanguage {
  return typeof v === 'string' && (LANGUAGE_IDS as readonly string[]).includes(v)
}

export function isNonCodeCategory(v: unknown): v is NonCodeCategory {
  return typeof v === 'string' && NON_CODE_SET.has(v)
}

export function isCodeLanguage(v: unknown): v is CodeLanguage {
  return isSessionLanguage(v) && v !== 'none' && v !== 'no_files' && !isNonCodeCategory(v)
}

/** Whether `v` can stand as a secondary — any id but `none` and `no_files`. */
export function isSecondaryLanguage(v: unknown): v is SecondaryLanguage {
  return isCodeLanguage(v) || isNonCodeCategory(v)
}

/** The language one path counts toward, or null when it is not a code file. A Vue/Svelte
 *  component reads `javascript` here; deriveSessionLanguage may count it as TypeScript. */
export function languageForPath(filePath: string): CodeLanguage | null {
  const c = classifyPath(filePath)
  return c && c.code ? c.lang : null
}

type PathClass =
  | { code: true; lang: CodeLanguage; component: boolean }
  | { code: false; lang: NonCodeCategory; component: false }

function classifyPath(filePath: string): PathClass | null {
  if (typeof filePath !== 'string' || filePath === '') return null
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = filePath.slice(slash + 1)
  if (base === '') return null
  // Dotfiles (.eslintrc.js, .env.local, .gitignore) are config, whatever their extension.
  if (base.startsWith('.')) return { code: false, lang: 'config', component: false }
  const lowerBase = base.toLowerCase()
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? lowerBase.slice(dot) : ''
  const lang = EXTENSION_LANGUAGE[ext]
  if (lang) return { code: true, lang, component: false }
  if (COMPONENT_SET.has(ext)) return { code: true, lang: 'javascript', component: true }
  if (OTHER_CODE_SET.has(ext)) return { code: true, lang: 'other', component: false }
  // By name first (go.mod, README.md would match docs either way), then by extension, then by the
  // name before the first dot (Dockerfile.dev, LICENSE-MIT is not matched — unknown stays unknown).
  const byName = NAME_CATEGORY[lowerBase] ?? EXTENSION_CATEGORY[ext] ?? NAME_CATEGORY[lowerBase.split('.')[0]]
  return byName ? { code: false, lang: byName, component: false } : null
}

function fileKey(filePath: string): string {
  const p = filePath.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p
}

export interface SessionLanguageResult {
  language: SessionLanguage
  languageSecondary: SecondaryLanguage | null
}

/** Derives a session's primary and secondary language (or non-code category) from the files it
 *  read and changed. */
export function deriveSessionLanguage(files: {
  filesRead?: readonly string[]
  filesChanged?: readonly string[]
  filesWritten?: readonly string[]
}): SessionLanguageResult {
  // Distinct file → (class, was it changed). A file both read and changed counts once, as changed.
  const seen = new Map<string, PathClass & { changed: boolean }>()
  let anyPath = false
  const add = (paths: readonly string[] | undefined, changed: boolean) => {
    for (const p of paths ?? []) {
      if (typeof p === 'string' && p !== '') anyPath = true
      const c = classifyPath(p)
      if (!c) continue
      const key = fileKey(p)
      const prev = seen.get(key)
      if (prev) prev.changed = prev.changed || changed
      else seen.set(key, { ...c, changed })
    }
  }
  add(files.filesChanged, true)
  add(files.filesWritten, true)
  add(files.filesRead, false)
  const all = [...seen.values()]
  // Vue/Svelte components follow the session's script language: TypeScript if it touched any.
  if (all.some(f => f.code && !f.component && f.lang === 'typescript')) {
    for (const f of all) if (f.code && f.component) f.lang = 'typescript'
  }

  // Code decides whenever there is any; only a code-free session is named by its files' kind.
  const code = all.filter(f => f.code)
  const pool = code.length > 0 ? code : all
  const tally = new Map<SecondaryLanguage, { files: number; changed: number }>()
  for (const { lang, changed } of pool) {
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
    language: ranked[0]?.[0] ?? (anyPath ? 'none' : 'no_files'),
    languageSecondary: ranked[1]?.[0] ?? null,
  }
}

/** Whether `secondary` may accompany `primary`: same tier (code with code, non-code with
 *  non-code), never the primary itself, and nothing at all for `none`/`no_files`. */
function validSecondary(primary: SessionLanguage, secondary: unknown): secondary is SecondaryLanguage {
  if (secondary === primary) return false
  if (isCodeLanguage(primary)) return isCodeLanguage(secondary)
  if (isNonCodeCategory(primary)) return isNonCodeCategory(secondary)
  return false
}

/** The language pair for a card rebuilt from a stored or untrusted record (an Import, a database
 *  row): the record's own `language`/`languageSecondary` when they are valid allowlisted ids,
 *  otherwise re-derived from its file lists. A stored `none` is also re-derived — it was written
 *  before the non-code categories existed, when every code-free session read `none`. Never passes
 *  an unrecognised string through. */
export function languageFromRecord(
  raw: { language?: unknown; languageSecondary?: unknown },
  files: { filesRead?: readonly string[]; filesChanged?: readonly string[] },
): SessionLanguageResult {
  if (isSessionLanguage(raw.language) && raw.language !== 'none') {
    return {
      language: raw.language,
      languageSecondary: validSecondary(raw.language, raw.languageSecondary) ? raw.languageSecondary : null,
    }
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
