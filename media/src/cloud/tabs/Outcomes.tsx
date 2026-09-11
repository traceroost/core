import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { vscode } from '../../state'

// ── Types (mirror src/turnover/index.ts + localReport.ts) ───────────────────

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

export const outcomesReport = signal<LocalTurnoverReport | null>(null)
export const outcomesLoading = signal(false)

export function requestOutcomes(): void {
  outcomesLoading.value = true
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

function MeasuredPanel({ r, coverage }: { r: Measured; coverage: TurnoverReport['coverage'] }) {
  const color = VERDICT_COLOR[r.benchmark.verdict]
  const covPct = coverage.totalMergedLines > 0 ? coverage.attributedLines / coverage.totalMergedLines : 0
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
      <div class="sub" style="margin-top:4px">
        Attribution determined for {pct(covPct)} of merged lines in this window.
      </div>
      <BenchmarkBar rate={r.turnoverRate} band={r.benchmark} />
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

// ── Share ──────────────────────────────────────────────────────────────────

function ShareBox({ repo }: { repo: RepoTurnover }) {
  const [includeLabel, setIncludeLabel] = useState(false)
  const latest = repo.report.results
    .filter((r): r is Measured => r.kind === 'measured' && r.windowDays === 90)
    .sort((a, b) => b.cohortLabel.localeCompare(a.cohortLabel))[0]
  if (!latest) return null

  const summary = [
    includeLabel ? `${repo.label}: ` : '',
    `${pct(latest.turnoverRate)} of the AI-authored code I merged in ${fmtDate(latest.cohortLabel + '-01')} `,
    `has since been rewritten or reverted (${latest.aiLinesAuthored.toLocaleString()} lines, ${latest.commitCount} commits). `,
    `Healthy benchmark: under ${pct(latest.benchmark.healthyUnder)}. — via AgentLens`,
  ].join('')

  return (
    <div class="card" style="margin-top:10px">
      <h4>Share this number</h4>
      <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin:4px 0">
        <input type="checkbox" checked={includeLabel} onChange={e => setIncludeLabel((e.target as HTMLInputElement).checked)} />
        Include the repository name ({repo.label})
      </label>
      <pre style="font-size:11px;white-space:pre-wrap;background:var(--vscode-editor-background);border:1px solid var(--border);border-radius:4px;padding:8px;margin:6px 0">{summary}</pre>
      <button
        onClick={() => { navigator.clipboard?.writeText(summary) }}
        style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
      >Copy summary</button>
    </div>
  )
}

// ── Tab ────────────────────────────────────────────────────────────────────

export function Outcomes() {
  const report = outcomesReport.value

  useEffect(() => { if (!report) requestOutcomes() }, [])

  if (!report) {
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

      {report.repos.map(repo => (
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
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                {([30, 90] as const).map(w => {
                  const r = repo.report.results
                    .filter(x => x.windowDays === w)
                    .sort((a, b) => b.cohortLabel.localeCompare(a.cohortLabel))[0]
                  if (!r) return <div key={w} class="card" style="border-style:dashed"><h4>{w}-day</h4><div class="sub">No cohort in range.</div></div>
                  return r.kind === 'measured'
                    ? <MeasuredPanel key={w} r={r} coverage={repo.report.coverage} />
                    : <InsufficientPanel key={w} r={r} />
                })}
              </div>
              <CohortTrend report={repo.report} />
              <ShareBox repo={repo} />
              {/* The wall, stated once. One Pro reference on this surface, in the cohort footer only. */}
              <div class="sub" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
                This is your own work on your own clones. The team-wide version — everyone's turnover,
                across people and repositories — is <a href="https://app.agentlens.dev" target="_blank" style="color:var(--accent)">AgentLens Pro</a>.
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
