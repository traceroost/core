/**
 * Post-hoc session risk signals — malfunction patterns that only show up once a session (or at
 * least an edit) is complete, unlike loopDetector.ts's real-time signals which fire mid-session.
 * Computed on demand (session detail view), the same lifecycle as gitOutcome.ts's classification —
 * not eagerly for every loaded session, since detectHallucinatedImports reads files from the
 * workspace on disk.
 *
 * Two detectors:
 *   - detectFailedCheckSubmission — the session's last test/build run failed and nothing followed.
 *   - detectHallucinatedImports   — an edit imports a package absent from the project's manifest
 *                                   and unresolvable on disk.
 *
 * Both are deliberately narrow. See .staged-issues/additional-malfunction-detections.md for the
 * broader set of failure modes considered and rejected as too false-positive-prone to ship —
 * these two are the ones that survived that review.
 */

import * as fs from 'fs'
import * as path from 'path'
import { LoopSignal } from './types'
import { SessionSummaryCard } from './spanSummarizer'
import { PATTERN_NAMES, LOOP_SIGNAL_ACTIONS } from './loopDetector'

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

// ── Detector: hallucinated import ────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const PYTHON_EXTENSIONS = new Set(['.py'])

// Not exhaustive — covers the common cases well enough to avoid the dominant false-positive
// source (every Python file imports `os`/`sys`, neither belongs in requirements.txt).
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'crypto', 'dns', 'events', 'fs', 'http', 'https',
  'net', 'os', 'path', 'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls',
  'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib', 'process', 'module', 'perf_hooks',
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
])

const JS_IMPORT_PATTERN = /import\s+(?:type\s+)?(?:[\w*${},\s]+\sfrom\s+)?['"]([^'"]+)['"]/g
const JS_REQUIRE_PATTERN = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const PY_IMPORT_PATTERN = /^\s*import\s+([\w.]+)/gm
const PY_FROM_IMPORT_PATTERN = /^\s*from\s+([\w.]+)\s+import/gm

function addJsPackageName(names: Set<string>, specifier: string): void {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) { return }
  const parts = specifier.split('/')
  const pkg = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  if (!pkg || NODE_BUILTINS.has(pkg)) { return }
  names.add(pkg)
}

function extractJsTsPackageNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(JS_IMPORT_PATTERN)) { addJsPackageName(names, m[1]) }
  for (const m of code.matchAll(JS_REQUIRE_PATTERN)) { addJsPackageName(names, m[1]) }
  return names
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
 *   - Excludes relative/local imports.
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

  for (const entry of session.timeline) {
    if (!entry.editDetails) { continue }
    for (const detail of entry.editDetails) {
      const code = detail.newString || detail.content || ''
      if (!code || !detail.filePath) { continue }
      const ext = path.extname(detail.filePath).toLowerCase()

      if (jsDeps && JS_TS_EXTENSIONS.has(ext)) {
        for (const pkg of extractJsTsPackageNames(code)) {
          if (jsDeps.has(pkg)) { continue }
          if (nodeModulesHasPackage(workspaceRoot, pkg)) { continue }
          if (!suspects.has(pkg)) { suspects.set(pkg, detail.filePath) }
        }
      }
      if (pyDeps && PYTHON_EXTENSIONS.has(ext)) {
        for (const pkg of extractPythonPackageNames(code)) {
          const normalized = pkg.toLowerCase().replace(/_/g, '-')
          if (pyDeps.has(normalized) || pyDeps.has(pkg.toLowerCase())) { continue }
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

/** Runs both post-hoc detectors and returns whatever fired. */
export function detectSessionRiskSignals(session: SessionSummaryCard, workspaceRoot: string): LoopSignal[] {
  const signals: LoopSignal[] = []
  const failedCheck = detectFailedCheckSubmission(session)
  if (failedCheck) { signals.push(failedCheck) }
  const hallucinatedImport = detectHallucinatedImports(session, workspaceRoot)
  if (hallucinatedImport) { signals.push(hallucinatedImport) }
  return signals
}
