import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { vscode } from '../../state'
import { teamStatus, requestTeamStatus } from '../panels/TeamPanel'

// ── Types (mirror src/turnover/index.ts + localReport.ts) ───────────────────

/** No message text — see the same field on src/cloud/turnover/index.ts's CommitDetail for why:
 *  commitScan.ts reads a commit's message only to detect an agent trailer, then discards it. */
interface CommitDetail {
  sha: string
  authoredAt: string
  linesAdded: number
  aiLines: number
  aiLinesSurviving: number
  attribution: 'certain' | 'probable' | 'unknown'
}

interface Measured {
  kind: 'measured'
  cohortLabel: string
  windowDays: 30 | 90
  turnoverRate: number
  aiLinesAuthored: number
  aiLinesSurviving: number
  commitCount: number
  mergeRange: { fromIso: string; toIso: string }
  benchmark: { low: number; high: number; healthyUnder: number; verdict: 'healthy' | 'typical' | 'elevated' }
  cohortShas: string[]
  /** Worst-survival-first — see index.ts's evaluateCohort. Absent on a report cached before this
   *  field existed. */
  commits?: CommitDetail[]
}
interface Insufficient {
  kind: 'insufficient'
  cohortLabel: string
  windowDays: 30 | 90
  reason: 'window-not-elapsed' | 'too-few-attributed-lines' | 'repository-younger-than-window' | 'no-commits'
  measurableAtIso?: string
  attributedAiLines?: number
}
type CohortTurnover = Measured | Insufficient

interface TurnoverReport {
  repoRoot: string
  headSha: string | null
  results: CohortTurnover[]
  coverage: { attributedLines: number; totalMergedLines: number }
  unavailable?: 'not-a-repo' | 'shallow-clone'
}
interface RepoTurnover { label: string; report: TurnoverReport }
export interface LocalTurnoverReport {
  repos: RepoTurnover[]
  hasMeasurableCohort: boolean
  generatedAt: string
}

/** Mirrors `LocalReportProgress` (src/cloud/turnover/localReport.ts) — attribute/blame progress
 *  for whichever repo of however many is currently being scanned. */
export interface OutcomesProgress {
  stage: 'attributing' | 'blaming'
  done: number
  total: number
  repoLabel: string
  repoIndex: number
  repoTotal: number
}

export const outcomesReport = signal<LocalTurnoverReport | null>(null)
export const outcomesLoading = signal(false)
export const outcomesProgress = signal<OutcomesProgress | null>(null)

export function requestOutcomes(): void {
  outcomesLoading.value = true
  outcomesProgress.value = null
  vscode?.postMessage({ type: 'getOutcomes' })
}

// ── Formatting ─────────────────────────────────────────────────────────────

const pct = (n: number) => `${(n * 100).toFixed(1)}%`
const fmtDate = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) } catch { return iso } }
const fmtDay = (iso: string) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) } catch { return iso } }

const VERDICT_COLOR: Record<Measured['benchmark']['verdict'], string> = {
  healthy: '#56D364',
  typical: '#f6a623',
  elevated: '#f44747',
}

const REASON_TEXT: Record<Insufficient['reason'], string> = {
  'window-not-elapsed': 'Not measurable yet — the window has not fully elapsed.',
  'too-few-attributed-lines': 'Not enough AI-authored lines could be attributed in this window to produce a stable figure.',
  'repository-younger-than-window': 'This repository is younger than the window.',
  'no-commits': 'No commits in this window.',
}

// ── Panels ─────────────────────────────────────────────────────────────────

function InsufficientPanel({ r }: { r: Insufficient }) {
  return (
    <div class="card" style="border-style:dashed">
      <h4>{r.windowDays}-day turnover · {fmtDate(r.cohortLabel + '-01')}</h4>
      <div style="font-size:14px;color:var(--fg);margin:4px 0">Not available yet</div>
      <div class="sub">{REASON_TEXT[r.reason]}</div>
      {r.reason === 'window-not-elapsed' && r.measurableAtIso && (
        <div class="sub" style="margin-top:4px">Available on <strong>{new Date(r.measurableAtIso).toLocaleDateString()}</strong>.</div>
      )}
      {typeof r.attributedAiLines === 'number' && (
        <div class="sub" style="margin-top:4px">{r.attributedAiLines} AI-authored line{r.attributedAiLines === 1 ? '' : 's'} attributed so far.</div>
      )}
    </div>
  )
}

function MeasuredPanel({ r }: { r: Measured }) {
  const color = VERDICT_COLOR[r.benchmark.verdict]
  return (
    <div class="card">
      <h4>{r.windowDays}-day turnover · {fmtDate(r.cohortLabel + '-01')}</h4>
      <div class="val" style={`color:${color}`}>{pct(r.turnoverRate)}</div>
      <div class="sub">
        of the {r.aiLinesAuthored.toLocaleString()} AI-authored lines merged here have since been
        rewritten or reverted. {r.aiLinesSurviving.toLocaleString()} still stand.
      </div>
      <div class="sub" style="margin-top:6px">
        {r.commitCount} commit{r.commitCount === 1 ? '' : 's'} ·
        merged {fmtDay(r.mergeRange.fromIso)}–{fmtDay(r.mergeRange.toIso)}
      </div>
      <BenchmarkBar rate={r.turnoverRate} band={r.benchmark} />
      {/* `?? []`: a cohort_turnover row cached before this field existed has no `commits` at all
          — HEAD hasn't moved, so it won't recompute on its own until something else invalidates it. */}
      <CommitDrilldown commits={r.commits ?? []} />
    </div>
  )
}

function CommitDrilldown({ commits }: { commits: CommitDetail[] }) {
  const [open, setOpen] = useState(false)
  if (commits.length === 0) return null
  return (
    <div style="margin-top:8px">
      <button
        onClick={() => setOpen(o => !o)}
        style="font-size:10px;color:var(--vscode-textLink-foreground,#4fc3f7);background:none;border:none;cursor:pointer;padding:0"
      >{open ? 'Hide' : 'Show'} the {commits.length} commit{commits.length === 1 ? '' : 's'} behind this number</button>
      {open && (
        <>
          <table style="width:100%;font-size:10px;margin-top:6px;border-collapse:collapse">
            <thead>
              <tr style="color:var(--muted);text-align:left;border-bottom:1px solid var(--border)">
                <th style="padding:2px 6px 2px 0;font-weight:500">Commit</th>
                <th style="padding:2px 6px;font-weight:500">Date</th>
                <th style="padding:2px 6px;text-align:right;font-weight:500">AI lines</th>
                <th style="padding:2px 6px;text-align:right;font-weight:500">Surviving</th>
                <th style="padding:2px 0;font-weight:500">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {commits.map(c => {
                const survivedFrac = c.aiLines > 0 ? c.aiLinesSurviving / c.aiLines : 1
                const survivedColor = survivedFrac < 0.3 ? '#f44747' : survivedFrac < 0.7 ? '#f6a623' : '#56D364'
                return (
                  <tr key={c.sha} style="border-bottom:1px solid var(--border)">
                    <td style="padding:3px 6px 3px 0;font-family:var(--vscode-editor-font-family,monospace);color:var(--muted)" title={`${c.sha} — run 'git show ${c.sha.slice(0, 12)}' in this repo for the full commit`}>
                      {c.sha.slice(0, 8)}
                    </td>
                    <td style="padding:3px 6px;color:var(--muted);white-space:nowrap">{fmtDay(c.authoredAt)}</td>
                    <td style="padding:3px 6px;text-align:right">{c.aiLines.toLocaleString()}</td>
                    <td style={`padding:3px 6px;text-align:right;color:${survivedColor}`}>{pct(survivedFrac)}</td>
                    <td style="padding:3px 0;color:var(--muted)">{c.attribution}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div class="sub" style="margin-top:4px">
            No commit messages here by design — TraceRoost reads a message only to check for an AI
            trailer, then discards it. Use the sha with your own git tools for the rest.
          </div>
        </>
      )}
    </div>
  )
}

function BenchmarkBar({ rate, band }: { rate: number; band: Measured['benchmark'] }) {
  const scaleMax = Math.max(0.4, band.high * 1.6, rate * 1.2)
  const x = (v: number) => `${Math.min(100, (v / scaleMax) * 100)}%`
  return (
    <div style="margin-top:10px">
      <div style="position:relative;height:8px;background:var(--vscode-editor-background);border:1px solid var(--border);border-radius:4px">
        <div style={`position:absolute;left:${x(band.low)};width:calc(${x(band.high)} - ${x(band.low)});top:0;bottom:0;background:#56D36433`} />
        <div style={`position:absolute;left:${x(rate)};top:-3px;width:2px;height:14px;background:var(--fg)`} />
      </div>
      <div class="sub" style="margin-top:3px">
        Published benchmark: {pct(band.low)}–{pct(band.high)} for {rate <= band.healthyUnder ? '— you are within the healthy range' : rate <= band.high ? '— typical' : '— above the typical range'}
      </div>
    </div>
  )
}

function CohortTrend({ report }: { report: TurnoverReport }) {
  const measured = report.results.filter((r): r is Measured => r.kind === 'measured' && r.windowDays === 90)
    .sort((a, b) => a.cohortLabel.localeCompare(b.cohortLabel))
  if (measured.length < 2) return null
  const max = Math.max(...measured.map(m => m.turnoverRate), 0.3)
  return (
    <div class="card" style="margin-top:10px">
      <h4>90-day turnover by merge cohort</h4>
      <div style="display:flex;align-items:flex-end;gap:4px;height:90px;margin-top:8px">
        {measured.map(m => (
          <div key={m.cohortLabel} style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px" title={`${fmtDate(m.cohortLabel + '-01')}: ${pct(m.turnoverRate)}`}>
            <div style={`width:100%;background:${VERDICT_COLOR[m.benchmark.verdict]};border-radius:2px 2px 0 0;height:${Math.max(2, (m.turnoverRate / max) * 78)}px`} />
            <span class="sub" style="font-size:9px">{m.cohortLabel.slice(2)}</span>
          </div>
        ))}
      </div>
      <div class="sub">The shape matters more than any single level.</div>
    </div>
  )
}

/** The two top-of-page cards only ever show the *latest* cohort per window — real, older
 *  measured cohorts still exist (they're what draws the trend sparkline above) but otherwise had
 *  no way to be seen or drilled into. Collapsed by default: a mature repo can have a year-plus of
 *  these, and this is "go find something," not "here's the headline." */
function PastCohorts({ report, exclude }: { report: TurnoverReport; exclude: CohortTurnover[] }) {
  const [open, setOpen] = useState(false)
  const excludeSet = new Set(exclude)
  const past = report.results
    .filter((r): r is Measured => r.kind === 'measured' && !excludeSet.has(r))
    .sort((a, b) => b.cohortLabel.localeCompare(a.cohortLabel) || a.windowDays - b.windowDays)
  if (past.length === 0) return null
  return (
    <div style="margin-top:10px">
      <button
        onClick={() => setOpen(o => !o)}
        style="font-size:11px;color:var(--vscode-textLink-foreground,#4fc3f7);background:none;border:none;cursor:pointer;padding:0"
      >{open ? 'Hide' : 'Show'} {past.length} earlier measured cohort{past.length === 1 ? '' : 's'}</button>
      {open && (
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">
          {past.map(r => <MeasuredPanel key={`${r.windowDays}-${r.cohortLabel}`} r={r} />)}
        </div>
      )}
    </div>
  )
}

// ── Share ──────────────────────────────────────────────────────────────────

function ShareBox({ repo }: { repo: RepoTurnover }) {
  const [includeLabel, setIncludeLabel] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const latest = repo.report.results
    .filter((r): r is Measured => r.kind === 'measured' && r.windowDays === 90)
    .sort((a, b) => b.cohortLabel.localeCompare(a.cohortLabel))[0]
  if (!latest) return null

  const summary = [
    includeLabel ? `${repo.label}: ` : '',
    `${pct(latest.turnoverRate)} of the AI-authored code I merged in ${fmtDate(latest.cohortLabel + '-01')} `,
    `has since been rewritten or reverted (${latest.aiLinesAuthored.toLocaleString()} lines, ${latest.commitCount} commits). `,
    `Healthy benchmark: under ${pct(latest.benchmark.healthyUnder)}. — via TraceRoost`,
  ].join('')

  const copy = () => {
    if (!navigator.clipboard) { setCopyState('failed'); setTimeout(() => setCopyState('idle'), 1500); return }
    navigator.clipboard.writeText(summary)
      .then(() => setCopyState('copied'))
      .catch(() => setCopyState('failed'))
      .finally(() => { setTimeout(() => setCopyState('idle'), 1500) })
  }

  return (
    <div class="card" style="margin-top:10px">
      <h4>Share this number</h4>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin:4px 0">
        <input type="checkbox" checked={includeLabel} onChange={e => setIncludeLabel((e.target as HTMLInputElement).checked)} />
        Include the repository name ({repo.label})
      </label>
      <pre style="font-size:11px;white-space:pre-wrap;background:var(--vscode-editor-background);border:1px solid var(--border);border-radius:4px;padding:8px;margin:6px 0">{summary}</pre>
      <button
        onClick={copy}
        style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
      >{copyState === 'copied' ? 'Copied ✓' : copyState === 'failed' ? 'Could not copy' : 'Copy summary'}</button>
    </div>
  )
}

// ── Tab ────────────────────────────────────────────────────────────────────

export function Outcomes() {
  const report = outcomesReport.value

  useEffect(() => { if (!report) requestOutcomes() }, [])
  // For the TraceRoost Cloud link in the footer below — resolves to whichever environment this
  // install actually points at (test/stage/prod), same as the Team panel. Harmless to request
  // even if the Team panel already populated it; the handler is idempotent and this tab has no
  // other reason to know team status.
  useEffect(() => { if (!teamStatus.value) requestTeamStatus() }, [])

  if (!report) {
    const p = outcomesProgress.value
    if (outcomesLoading.value && p && p.total > 0) {
      const pct = Math.round((p.done / p.total) * 100)
      const stageLabel = p.stage === 'attributing' ? 'Matching commits to your sessions' : 'Checking which lines still survive'
      const repoSuffix = p.repoTotal > 1 ? ` — ${p.repoLabel} (repo ${p.repoIndex} of ${p.repoTotal})` : ` — ${p.repoLabel}`
      return (
        <div style="padding:20px;max-width:420px">
          <p class="import-progress-label">{stageLabel}{repoSuffix}</p>
          <div class="import-progress-track"><div class="import-progress-fill" style={`width:${pct}%`} /></div>
          <p class="import-progress-text">{p.done} / {p.total}</p>
        </div>
      )
    }
    return <div style="padding:20px;color:var(--muted);font-size:13px">{outcomesLoading.value ? 'Reading your git history and session records — locally…' : 'Loading…'}</div>
  }

  if (report.repos.length === 0) {
    return (
      <div style="padding:20px;max-width:640px">
        <h3 style="margin:0 0 8px">AI code turnover — your own work</h3>
        <p style="font-size:13px;color:var(--muted);line-height:1.6">
          This tab answers one question about your own commits: of the code an agent wrote and you
          merged, how much is still there weeks later. It needs a git repository with some history
          and a few recorded sessions. Open a project and run an agent session, then come back.
        </p>
      </div>
    )
  }

  return (
    <div style="padding:16px;max-width:760px">
      <h3 style="margin:0 0 4px">AI code turnover — your own work</h3>
      <p class="sub" style="margin:0 0 14px">
        Computed locally from your git history and session records. No account, no network, nothing sent.
      </p>

      {report.repos.map(repo => {
        // The latest cohort per window is the headline; everything else measured is real,
        // older data that only existed via the trend sparkline — see PastCohorts below.
        const latestPerWindow = ([30, 90] as const)
          .map(w => repo.report.results.filter(x => x.windowDays === w).sort((a, b) => b.cohortLabel.localeCompare(a.cohortLabel))[0])
          .filter((r): r is CohortTurnover => r !== undefined)

        const cov = repo.report.coverage
        const covPct = cov.totalMergedLines > 0 ? cov.attributedLines / cov.totalMergedLines : 0

        return (
          <div key={repo.report.repoRoot} style="margin-bottom:22px">
            {report.repos.length > 1 && <div class="section-label">{repo.label}</div>}
            {repo.report.unavailable ? (
              <div class="card" style="border-style:dashed">
                <div class="sub">
                  {repo.report.unavailable === 'shallow-clone'
                    ? 'This is a shallow clone — turnover needs full history. Run `git fetch --unshallow`.'
                    : 'Not a git repository.'}
                </div>
              </div>
            ) : (
              <>
                {/* Report-wide, not per-cohort — shown once here rather than repeated identically
                    inside every card below (all of which would otherwise show the same number and
                    read as if it were scoped to that specific window/cohort). */}
                <div class="sub" style="margin-bottom:8px">
                  Attribution determined for {pct(covPct)} of this repository's merged lines overall.
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                  {([30, 90] as const).map(w => {
                    const r = latestPerWindow.find(x => x.windowDays === w)
                    if (!r) return <div key={w} class="card" style="border-style:dashed"><h4>{w}-day</h4><div class="sub">No cohort in range.</div></div>
                    return r.kind === 'measured'
                      ? <MeasuredPanel key={w} r={r} />
                      : <InsufficientPanel key={w} r={r} />
                  })}
                </div>
                <PastCohorts report={repo.report} exclude={latestPerWindow} />
                <CohortTrend report={repo.report} />
                <ShareBox repo={repo} />
                {/* The wall, stated once. One Cloud reference on this surface, in the cohort footer only. */}
                <div class="sub" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
                  This is your own work on your own clones. The team-wide version — everyone's turnover,
                  across people and repositories — is <a href={teamStatus.value?.endpoint ?? 'https://traceroost.com'} target="_blank" style="color:var(--accent)">TraceRoost Cloud</a>.
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
