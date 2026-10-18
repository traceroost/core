/**
 * Freedesktop `.desktop` files: the format behind both Linux login launch (an XDG autostart entry)
 * and the AppImage's opt-in launcher entry.
 *
 * The one part of this that is easy to get wrong is the `Exec` key. It is not a shell command line
 * and not a plain string either: the Desktop Entry Specification quotes arguments with double
 * quotes, backslash-escapes `"`, `` ` ``, `$` and `\` inside them, reserves `%` for field codes, and
 * *then* applies the general string-value escaping on top, which doubles every backslash again. An
 * AppImage lives wherever the user saved it — `~/Downloads/Trace Roost (1).AppImage`, or a home
 * directory with a non-ASCII name — so the path cannot be assumed to need none of this.
 *
 * https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html
 */

/** Characters that force an `Exec` argument to be quoted. */
const RESERVED = /[\s"'\\><~|&;$*?#()`]/

/** Escapes a value for a desktop entry *string* key (`Name`, `TryExec`, and the already-quoted
 *  `Exec`): backslash, then the control characters the spec names. */
export function escapeDesktopString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
}

/** One `Exec` argument, quoted when it has to be. `%` is always doubled: a literal `%` would
 *  otherwise be read as the start of a field code. */
export function quoteExecArg(arg: string): string {
  const literalPercent = arg.replace(/%/g, '%%')
  if (literalPercent !== '' && !RESERVED.test(literalPercent)) return literalPercent
  return `"${literalPercent.replace(/(["`$\\])/g, '\\$1')}"`
}

/** The full `Exec` value for a program and its arguments, escaped for the file. */
export function execLine(program: string, args: readonly string[] = []): string {
  return escapeDesktopString([program, ...args].map(quoteExecArg).join(' '))
}

/**
 * Reverses `execLine` far enough to recover the program and its arguments. Used to tell whether an
 * existing entry still points at this copy of the app; anything it does not understand comes back
 * as `undefined` rather than a guess.
 */
export function parseExecLine(value: string): string[] | undefined {
  // Undo the string-level escaping first, then the Exec-level quoting.
  let unescaped = ''
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c !== '\\') { unescaped += c; continue }
    const next = value[++i]
    if (next === undefined) return undefined
    unescaped += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === '\\' ? '\\' : `\\${next}`
  }
  const args: string[] = []
  let current = ''
  let inQuotes = false
  let started = false
  for (let i = 0; i < unescaped.length; i++) {
    const c = unescaped[i]
    if (inQuotes) {
      if (c === '\\') {
        const next = unescaped[++i]
        if (next === undefined) return undefined
        current += next
      } else if (c === '"') {
        inQuotes = false
      } else {
        current += c
      }
      continue
    }
    if (c === '"') { inQuotes = true; started = true; continue }
    if (c === ' ') {
      if (started) { args.push(current); current = ''; started = false }
      continue
    }
    current += c
    started = true
  }
  if (inQuotes) return undefined
  if (started) args.push(current)
  return args.map(a => a.replace(/%%/g, '%'))
}

/** Renders a `[Desktop Entry]` group. Values are written exactly as given, so string values must
 *  already be escaped (`escapeDesktopString`, or `execLine` for `Exec`). */
export function renderDesktopEntry(fields: readonly (readonly [string, string])[]): string {
  return ['[Desktop Entry]', ...fields.map(([k, v]) => `${k}=${v}`), ''].join('\n')
}

/** Reads the keys of the `[Desktop Entry]` group. Values are returned raw (still escaped). */
export function parseDesktopEntry(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  let inMainGroup = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[')) { inMainGroup = line === '[Desktop Entry]'; continue }
    if (!inMainGroup) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return fields
}
