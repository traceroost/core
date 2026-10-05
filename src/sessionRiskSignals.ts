/**
 * Post-hoc session risk signals — malfunction patterns that only show up once a session (or at
 * least an edit) is complete, unlike loopDetector.ts's real-time signals which fire mid-session.
 * Computed on demand (session detail view), the same lifecycle as gitOutcome.ts's classification —
 * not eagerly for every loaded session, since detectHallucinatedImports reads files from the
 * workspace on disk.
 *
 * Three detectors:
 *   - detectFailedCheckSubmission — the session's last test/build run failed and nothing followed.
 *   - detectHallucinatedImports   — an edit imports a package absent from the project's manifest
 *                                   and unresolvable on disk.
 *   - detectSkippedChecks         — the session's changes reached the shared branch, but no
 *                                   test/build check ever ran (signal-catalog stage 05;
 *                                   runbooks/SIGNAL_CALIBRATION.md).
 *
 * The first two are deliberately narrow: the broader set of failure modes considered for post-hoc
 * detection (silent scope creep, dependency drift, unexplained deletions, …) was rejected as too
 * false-positive-prone to ship without a corpus to calibrate against — these are the ones that
 * survived that review.
 */

import * as fs from 'fs'
import * as path from 'path'
import { LoopSignal } from './types'
import { SessionSummaryCard } from './spanSummarizer'
import { PATTERN_NAMES, LOOP_SIGNAL_ACTIONS } from './loopDetector'
import { GitOutcome } from './gitOutcome'

// ── Detector: failed check submission ────────────────────────────────────────

const TEST_RUNNER_PATTERN =
  /\b(npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|pytest|python3?\s+-m\s+pytest|go\s+test|cargo\s+test|jest|vitest|mvn\s+test|rspec)\b/i
const FAILURE_TEXT_PATTERN = /\bfail(ed|ure|ing)?\b|✗|✘|✖/i

/**
 * Precision-good, recall-poor by design: most sessions never invoke a test runner unless
 * explicitly told to, so this only catches the slice of failures where the agent happened to
 * check its own work and ignored the result. Only looks at the *last* tool call in the timeline —
 * a failing check followed by more edits (a fix attempt) is not what this flags.
 *
 * Calibration check (scripts/calibrateSignals.ts, see runbooks/SIGNAL_CALIBRATION.md): zero
 * firings across 236 real sessions checked — the narrow-by-design scoping here means that may just
 * reflect how rarely a session both runs a check and ends immediately after a failure, not that
 * anything is miscalibrated. No data either way yet; revisit as the corpus grows.
 */
export function detectFailedCheckSubmission(session: SessionSummaryCard): LoopSignal | null {
  const timeline = session.timeline
  let lastTool: SessionSummaryCard['timeline'][number] | null = null
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === 'tool') { lastTool = timeline[i]; break }
  }
  if (!lastTool) { return null }

  const invocation = lastTool.toolInput || lastTool.label || ''
  if (!TEST_RUNNER_PATTERN.test(invocation)) { return null }

  const resultText = lastTool.resultSummary || lastTool.fullResult || ''
  const failed = lastTool.isError || FAILURE_TEXT_PATTERN.test(resultText)
  if (!failed) { return null }

  return {
    type: 'failed_check_submission',
    severity: 'warning',
    evidence: 'The last check run in this session reported a failure, with no further fix attempt before the session ended.',
    count: 1,
    examples: [invocation.slice(0, 100)],
    patternName: PATTERN_NAMES.failed_check_submission,
    action: LOOP_SIGNAL_ACTIONS.failed_check_submission,
  }
}

// ── Detector: skipped checks ─────────────────────────────────────────────────

/**
 * Datadog's own published rule: `commit_count > 0 && push_count > 0 && test_fix_cycle_count == 0`
 * — changes shipped without ever being verified. This codebase has no reliable way to observe a
 * `git push` directly: default Claude Code telemetry redacts Bash tool arguments, so a session's
 * own `Bash` tool calls carry no command text to match `git push` against (confirmed against real
 * sessions during the signal-catalog stage 05 spike). Uses `outcome.overall
 * === 'merged'` instead — gitOutcome.ts's `resolveTrunkRef` already prefers a remote-tracking ref
 * (`refs/remotes/origin/HEAD`/`origin/main`) over the local branch when a remote exists, so
 * 'merged' already means this content reached the remote-tracked trunk, which requires a push to
 * be true. A reasonable proxy in this product's single-developer scope, not literal push detection
 * — see the SIGNAL_FORMULAS caveat for the real risk this introduces (a task with nothing to test
 * will always fire this).
 */
export function detectSkippedChecks(session: SessionSummaryCard, outcome: GitOutcome | null): LoopSignal | null {
  if (!outcome || outcome.overall !== 'merged') { return null }

  const ranCheck = session.timeline.some(
    e => e.type === 'tool' && TEST_RUNNER_PATTERN.test(e.toolInput || e.label || ''),
  )
  if (ranCheck) { return null }

  return {
    type: 'skipped_checks',
    severity: 'warning',
    evidence: 'This session\'s changes reached the shared branch, but no test/build check ever ran during the session.',
    count: 1,
    examples: [],
    patternName: PATTERN_NAMES.skipped_checks,
    action: LOOP_SIGNAL_ACTIONS.skipped_checks,
  }
}

// ── Detector: hallucinated import ────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const PYTHON_EXTENSIONS = new Set(['.py'])

// Not exhaustive — covers the common cases well enough to avoid the dominant false-positive
// source (every Python file imports `os`/`sys`, neither belongs in requirements.txt).
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dns', 'events', 'fs', 'http', 'https',
  'net', 'os', 'path', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'process', 'module', 'perf_hooks',
  'async_hooks', 'console', 'constants', 'dgram', 'diagnostics_channel', 'domain', 'http2',
  'inspector', 'punycode', 'repl', 'sys', 'trace_events', 'wasi',
])
const PYTHON_STDLIB = new Set([
  'os', 'sys', 'json', 're', 'math', 'time', 'datetime', 'collections', 'itertools', 'functools',
  'pathlib', 'subprocess', 'typing', 'dataclasses', 'unittest', 'logging', 'threading', 'asyncio',
  'socket', 'http', 'urllib', 'shutil', 'tempfile', 'io', 'csv', 'sqlite3', 'random', 'string',
  'copy', 'enum', 'abc', 'contextlib', 'argparse', 'hashlib', 'base64', 'pickle', 'struct',
  'traceback', 'warnings', 'inspect', 'importlib', 'glob', 'fnmatch', 'textwrap', 'pprint',
  'operator', 'queue', 'multiprocessing', 'xml', 'html', 'email', 'ftplib', 'smtplib', 'ssl',
  'ipaddress', 'uuid', 'decimal', 'fractions', 'statistics', 'array', 'bisect', 'heapq', 'weakref',
  'gc', 'platform', 'getpass', 'configparser', 'zipfile', 'tarfile', 'gzip', 'bz2', 'lzma',
  'signal', 'shlex', 'difflib',
  '__future__', 'types', 'ast', 'concurrent', 'codecs', 'locale', 'secrets', 'select', 'selectors',
  'mmap', 'ctypes', 'dis', 'token', 'tokenize', 'keyword', 'numbers', 'cmath', 'zoneinfo',
  'graphlib', 'contextvars', 'sched', 'stat', 'filecmp', 'fileinput', 'linecache', 'code', 'codeop',
  'pdb', 'profile', 'cProfile', 'pstats', 'timeit', 'trace', 'tracemalloc', 'doctest', 'venv',
  'site', 'sysconfig', 'builtins', 'errno', 'faulthandler', 'atexit', 'marshal', 'shelve', 'dbm',
  'zlib', 'binascii', 'calendar', 'gettext', 'unicodedata', 'reprlib', 'optparse', 'getopt',
  'curses', 'readline', 'rlcompleter', 'termios', 'tty', 'pty', 'fcntl', 'resource', 'grp', 'pwd',
  'posix', 'nt', 'msvcrt', 'winreg', 'winsound', 'webbrowser', 'wsgiref', 'xmlrpc', 'socketserver',
  'mimetypes', 'mailbox', 'quopri', 'imaplib', 'poplib', 'tomllib', 'pkgutil', 'zipimport',
  'zipapp', 'runpy', 'ensurepip', 'plistlib', 'netrc', 'hmac', 'tkinter', 'turtle', 'colorsys',
  'wave', 'sre_constants', 'sre_parse', 'sre_compile', 'copyreg', 'pydoc',
  'asynchat', 'asyncore', 'imp', 'distutils', 'lib2to3',
])

// Import name → the distribution name(s) that provide it, for the common packages whose two names
// differ. requirements.txt lists the distribution (`PyYAML`), code imports the module (`yaml`).
const PYTHON_IMPORT_TO_DIST: Record<string, string[]> = {
  yaml: ['pyyaml', 'ruamel-yaml'],
  PIL: ['pillow', 'pil'],
  sklearn: ['scikit-learn'],
  skimage: ['scikit-image'],
  cv2: ['opencv-python', 'opencv-python-headless', 'opencv-contrib-python', 'opencv-contrib-python-headless'],
  bs4: ['beautifulsoup4'],
  dateutil: ['python-dateutil'],
  dotenv: ['python-dotenv'],
  jwt: ['pyjwt'],
  jose: ['python-jose'],
  attr: ['attrs'],
  Crypto: ['pycryptodome', 'pycrypto'],
  Cryptodome: ['pycryptodomex'],
  OpenSSL: ['pyopenssl'],
  serial: ['pyserial'],
  usb: ['pyusb'],
  magic: ['python-magic'],
  docx: ['python-docx'],
  pptx: ['python-pptx'],
  git: ['gitpython'],
  multipart: ['python-multipart'],
  zmq: ['pyzmq'],
  win32api: ['pywin32'],
  win32con: ['pywin32'],
  psycopg2: ['psycopg2-binary'],
  MySQLdb: ['mysqlclient'],
  fitz: ['pymupdf'],
  telegram: ['python-telegram-bot'],
  slugify: ['python-slugify'],
  websocket: ['websocket-client'],
  google: [],  // namespace package — any google-* distribution provides it, see below
  pkg_resources: ['setuptools'],
  setuptools: ['setuptools'],
  Levenshtein: ['python-levenshtein', 'levenshtein'],
  sentencepiece: ['sentencepiece'],
  faiss: ['faiss-cpu', 'faiss-gpu'],
  mpl_toolkits: ['matplotlib'],
}

const JS_IMPORT_PATTERN = /import\s+(?:type\s+)?(?:[\w*${},\s]+\sfrom\s+)?['"]([^'"]+)['"]/g
const JS_REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const PY_IMPORT_PATTERN = /^\s*import\s+([\w.]+)/gm
const PY_FROM_IMPORT_PATTERN = /^\s*from\s+([\w.]+)\s+import/gm

// `@/…` and `~/…` are the conventional tsconfig/bundler path aliases (never valid npm names), and
// `#…` is a package.json `imports` subpath — none of them name a package.
function isAliasSpecifier(specifier: string, aliasPrefixes: string[]): boolean {
  if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier === '~' || specifier.startsWith('#')) { return true }
  return aliasPrefixes.some(prefix => specifier === prefix || specifier.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))
}

function addJsPackageName(names: Set<string>, specifier: string, aliasPrefixes: string[]): void {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) { return }
  if (isAliasSpecifier(specifier, aliasPrefixes)) { return }
  const parts = specifier.split('/')
  const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!pkg || NODE_BUILTINS.has(pkg)) { return }
  names.add(pkg)
}

function extractJsTsPackageNames(code: string, aliasPrefixes: string[] = []): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(JS_IMPORT_PATTERN)) { addJsPackageName(names, m[1], aliasPrefixes) }
  for (const m of code.matchAll(JS_REQUIRE_PATTERN)) { addJsPackageName(names, m[1], aliasPrefixes) }
  return names
}

/** Alias prefixes from tsconfig.json/jsconfig.json `compilerOptions.paths` (`"@app/*"` → `@app`).
 *  Best-effort: a tsconfig that isn't plain JSON after stripping comments/trailing commas, or that
 *  only defines paths through `extends`, contributes nothing. */
function readTsPathAliases(workspaceRoot: string): string[] {
  const aliases: string[] = []
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const p = path.join(workspaceRoot, name)
      if (!fs.existsSync(p)) { continue }
      const raw = fs.readFileSync(p, 'utf-8')
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '')
        .replace(/,(\s*[}\]])/g, '$1')
      const cfg = JSON.parse(raw) as { compilerOptions?: { paths?: Record<string, unknown> } }
      for (const key of Object.keys(cfg.compilerOptions?.paths ?? {})) {
        const prefix = key.replace(/\/?\*$/, '')
        if (prefix) { aliases.push(prefix) }
      }
    } catch { /* unparseable — no aliases from this file */ }
  }
  return aliases
}

/** True when a Python import could be satisfied by a module in the project itself: a `<name>.py`
 *  or `<name>/` package next to the importing file, at the workspace root, or under `src/`, or a
 *  file this same session wrote. */
function pythonModuleIsLocal(workspaceRoot: string, importingFile: string, name: string, sessionFiles: Set<string>): boolean {
  if (sessionFiles.has(name)) { return true }
  const fileAbs = path.isAbsolute(importingFile) ? importingFile : path.join(workspaceRoot, importingFile)
  for (const dir of [path.dirname(fileAbs), workspaceRoot, path.join(workspaceRoot, 'src')]) {
    try {
      if (fs.existsSync(path.join(dir, name + '.py')) || fs.existsSync(path.join(dir, name))) { return true }
    } catch { /* treat as absent */ }
  }
  return false
}

function pythonDepDeclared(pyDeps: Set<string>, pkg: string): boolean {
  const normalized = pkg.toLowerCase().replace(/_/g, '-')
  if (pyDeps.has(normalized) || pyDeps.has(pkg.toLowerCase())) { return true }
  if (pkg === 'google') { return [...pyDeps].some(d => d.startsWith('google-') || d === 'protobuf' || d === 'grpcio') }
  return (PYTHON_IMPORT_TO_DIST[pkg] ?? []).some(dist => pyDeps.has(dist))
}

function addPythonPackageName(names: Set<string>, dotted: string): void {
  if (dotted.startsWith('.')) { return }
  const top = dotted.split('.')[0]
  if (!top || PYTHON_STDLIB.has(top)) { return }
  names.add(top)
}

function extractPythonPackageNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(PY_IMPORT_PATTERN)) { addPythonPackageName(names, m[1]) }
  for (const m of code.matchAll(PY_FROM_IMPORT_PATTERN)) { addPythonPackageName(names, m[1]) }
  return names
}

function readJsManifestDeps(workspaceRoot: string): Set<string> | null {
  try {
    const pkgPath = path.join(workspaceRoot, 'package.json')
    if (!fs.existsSync(pkgPath)) { return null }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, Record<string, string> | undefined>
    const deps = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[field] ?? {})) { deps.add(name) }
    }
    // A VS Code extension imports `vscode`, which the editor provides at runtime — it's never a
    // dependency, only `engines.vscode` / `@types/vscode` say it's there.
    if (pkg['engines']?.['vscode'] || deps.has('@types/vscode')) { deps.add('vscode') }
    return deps
  } catch {
    return null
  }
}

function readPythonManifestDeps(workspaceRoot: string): Set<string> | null {
  try {
    const reqPath = path.join(workspaceRoot, 'requirements.txt')
    if (!fs.existsSync(reqPath)) { return null }
    const deps = new Set<string>()
    for (const line of fs.readFileSync(reqPath, 'utf-8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) { continue }
      const name = trimmed.split(/[=<>!~;\s[]/)[0].trim()
      if (name) { deps.add(name.toLowerCase().replace(/_/g, '-')) }
    }
    return deps
  } catch {
    return null
  }
}

function nodeModulesHasPackage(workspaceRoot: string, pkg: string): boolean {
  try {
    return fs.existsSync(path.join(workspaceRoot, 'node_modules', pkg))
  } catch {
    return false
  }
}

/**
 * Requires real scoping to hold up, not just "the data is there":
 *   - Excludes each language's built-ins/stdlib (every Python file imports os/sys — neither
 *     belongs in requirements.txt).
 *   - Excludes relative/local imports: JS path aliases (`@/`, `~/`, `#`, tsconfig `paths`) and
 *     Python modules that exist in the project on disk (or that this session wrote).
 *   - Maps Python import names to their distribution names (`yaml` → PyYAML, `PIL` → Pillow, …).
 *   - Treats `vscode` as provided in a VS Code extension workspace (`engines.vscode`).
 *   - Excludes anything that resolves under node_modules on disk, even if absent from
 *     package.json's declared fields — covers monorepo workspace packages (`@myorg/shared`
 *     resolved via workspace protocol) without needing to parse workspace globs, a real
 *     false-positive source this project's own repo shape would hit otherwise.
 *
 * Calibration check (scripts/calibrateSignals.ts, see runbooks/SIGNAL_CALIBRATION.md): the
 * best-validated signal in the whole taxonomy so far — fired on 15% of 236 real sessions checked,
 * a real minority, with a 64% bad-outcome rate among those vs. a 49% baseline (+15pp lift, n=33
 * with a resolvable outcome). Worth noting when tempted to second-guess this one; the narrow
 * scoping above is doing its job.
 *

 * Returns null (says nothing) rather than a false negative when there's no manifest to check
 * against at all — silence, not a claim of cleanliness.
 */
export function detectHallucinatedImports(session: SessionSummaryCard, workspaceRoot: string): LoopSignal | null {
  if (!workspaceRoot) { return null }

  const jsDeps = readJsManifestDeps(workspaceRoot)
  const pyDeps = readPythonManifestDeps(workspaceRoot)
  if (!jsDeps && !pyDeps) { return null }

  const suspects = new Map<string, string>()
  const aliasPrefixes = jsDeps ? readTsPathAliases(workspaceRoot) : []
  // Python modules this session itself created/edited (`utils.py` → `utils`, `pkg/__init__.py` → `pkg`).
  const sessionPyModules = new Set<string>()
  for (const entry of session.timeline) {
    for (const detail of entry.editDetails ?? []) {
      if (!detail.filePath || path.extname(detail.filePath).toLowerCase() !== '.py') { continue }
      const base = path.basename(detail.filePath, '.py')
      sessionPyModules.add(base === '__init__' ? path.basename(path.dirname(detail.filePath)) : base)
    }
  }

  for (const entry of session.timeline) {
    if (!entry.editDetails) { continue }
    for (const detail of entry.editDetails) {
      const code = detail.newString || detail.content || ''
      if (!code || !detail.filePath) { continue }
      const ext = path.extname(detail.filePath).toLowerCase()

      if (jsDeps && JS_TS_EXTENSIONS.has(ext)) {
        for (const pkg of extractJsTsPackageNames(code, aliasPrefixes)) {
          if (jsDeps.has(pkg)) { continue }
          if (nodeModulesHasPackage(workspaceRoot, pkg)) { continue }
          if (!suspects.has(pkg)) { suspects.set(pkg, detail.filePath) }
        }
      }
      if (pyDeps && PYTHON_EXTENSIONS.has(ext)) {
        for (const pkg of extractPythonPackageNames(code)) {
          if (pythonDepDeclared(pyDeps, pkg)) { continue }
          // A bare `import helpers` is as likely a sibling module as a package — only flag it when
          // nothing by that name exists in the project on disk.
          if (pythonModuleIsLocal(workspaceRoot, detail.filePath, pkg, sessionPyModules)) { continue }
          if (!suspects.has(pkg)) { suspects.set(pkg, detail.filePath) }
        }
      }
    }
  }

  if (suspects.size === 0) { return null }

  return {
    type: 'hallucinated_import',
    severity: 'warning',
    evidence: `${suspects.size} import(s) reference a package not declared in the project's manifest and not present on disk`,
    count: suspects.size,
    examples: [...suspects.entries()].slice(0, 3).map(([pkg, file]) => `${pkg} (${file.split('/').pop()})`),
    patternName: PATTERN_NAMES.hallucinated_import,
    action: LOOP_SIGNAL_ACTIONS.hallucinated_import,
  }
}

/** Runs all post-hoc detectors and returns whatever fired. `outcome` is optional (defaults to
 *  null, disabling detectSkippedChecks) since several existing callers don't have a GitOutcome
 *  in hand — passing it in is free wherever one's already been computed for the same session. */
export function detectSessionRiskSignals(session: SessionSummaryCard, workspaceRoot: string, outcome: GitOutcome | null = null): LoopSignal[] {
  const signals: LoopSignal[] = []
  const failedCheck = detectFailedCheckSubmission(session)
  if (failedCheck) { signals.push(failedCheck) }
  const hallucinatedImport = detectHallucinatedImports(session, workspaceRoot)
  if (hallucinatedImport) { signals.push(hallucinatedImport) }
  const skippedChecks = detectSkippedChecks(session, outcome)
  if (skippedChecks) { signals.push(skippedChecks) }
  return signals
}
