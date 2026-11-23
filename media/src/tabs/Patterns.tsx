import { useState, useEffect } from 'preact/hooks'
import { computed } from '@preact/signals'
import { filteredSessions, currentWorkspace, vscode, availableWorkspaces, workspaceFilter, filtersOpen, filtersFocusField, selectedAgentFilter, advisorView, setAdvisorView, type AdvisorView } from '../state'
import { Instructions, instructionFiles, instructionsAcrossWorkspaces, pendingInstructionCount } from './Instructions'
import { getCostSavingActions, type CostSavingAction } from '../costSavingActions'
import { planUsage, forAgentFilter, hasPlanData } from '../planUsage'
import { showLimitTraces, PlanFixesChart } from './PlanLimits'
import { LOOP_SIGNAL_ICON_TYPE, SIGNAL_ICON, SignalBadge } from '../signalIcons'
import { SIGNAL_FORMULAS } from '../signalFormulas'
import { ViewNav, ViewHeader, ViewSection, type ViewNavItem } from '../ViewNav'


// ── Main export ───────────────────────────────────────────────────────────────

// Same stroke-icon convention as ../signalIcons.tsx (24x24 viewBox, stroke-width 2, 13x13
// rendered) rather than emoji, for the two action kinds that aren't loop signals and so have no
// icon of their own in the traces table's Signals column. Path data adapted from Lucide
// (lucide.dev, ISC license): zap / file-text.
function IconZap({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </svg>
  )
}

function IconFileText({ color }: { color: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={color} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  )
}

// Loop-signal actions draw the exact same glyph the traces table's Signals column uses for that
// pattern (same convention as Insights.tsx's InsightIcon) so "how to spend less" and the Signals
// column always agree on what a given struggle pattern looks like — in the same SignalBadge tile.
// Non-loop kinds have no traces-table equivalent, so they get a plain icon on the neutral tile, so
// every row of the list carries the same tile shape.
function ActionIcon({ a }: { a: CostSavingAction }) {
  if (a.kind === 'loop_signal') {
    const iconType = a.loopSignalType ? LOOP_SIGNAL_ICON_TYPE[a.loopSignalType] : undefined
    if (iconType && SIGNAL_ICON[iconType]) return <SignalBadge type={iconType} severity={a.loopSignalSeverity ?? 'warning'} />
  }
  return <span class="sig-badge neutral md">{a.kind === 'cache_rate' ? <IconZap color="currentColor" /> : <IconFileText color="currentColor" />}</span>
}

// Loop-signal rows get the same bold-heading-plus-"What to do" hover as the Signals column's own
// icon tooltip (Sessions.tsx's SignalsCell) — reusing SIGNAL_FORMULAS' short/tip fields rather than
// the full LOOP_SIGNAL_ACTIONS paragraph already shown inline below the icon. Other kinds (cache
// rate, hot file) have no per-signal formula to draw from, so they're left without a tooltip.
function actionTipFor(a: CostSavingAction): string | null {
  if (a.kind !== 'loop_signal' || !a.loopSignalType) return null
  const f = SIGNAL_FORMULAS[a.loopSignalType]
  if (!f) return null
  return `<b>${a.title}</b>\n${f.short}\n<b>What to do:</b> ${f.tip}`
}

/** Pulls loop-signal actions, hot-file suggestions, and cache hit rate — each already computed
 *  elsewhere in this tab or in Insights — into one ranked "do these things to spend less" list.
 *  Built only from signals already computed (costSavingActions.ts) — no new heuristics here. */
/** Suggests narrowing to one repo via the header's Repo filter (in the Filters popover): instruction-file suggestions are
 *  only as specific as the traces behind them. Gone once a repo is chosen, when there's only one
 *  repo (the filter isn't shown), when this window's open folder already scopes them, or in the
 *  standalone dashboard, where they're already grouped per repo and each group applies to its own. */
function RepoFilterHint() {
  if (workspaceFilter.value.trim() !== '' || availableWorkspaces.value.length < 2 || currentWorkspace.value !== null || instructionsAcrossWorkspaces()) return null
  // Repo sits in the header's Filters popover: open it with focus on the Repo field.
  const focusRepo = () => {
    filtersFocusField.value = 'tr-filter-repo'
    filtersOpen.value = true
  }
  return (
    <div style="display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:6px 10px;font-size:11px;color:var(--muted);background:var(--card-bg);border:1px solid var(--border);border-radius:4px">
      <span style="flex:1">Tip: pick a repo under <strong style="color:var(--fg)">Filters → Repo</strong> in the header above for suggestions tailored to that repo's instruction file.</span>
      <button onClick={focusRepo}
        style="padding:2px 8px;font-size:var(--fs-xs);border-radius:3px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);white-space:nowrap">Choose repo ↑</button>
    </div>
  )
}

function fmtPts(p: number): string {
  return p < 1 ? '<1 pt' : `${Math.round(p)} pt${Math.round(p) === 1 ? '' : 's'}`
}

function SaveMoneyCard({ actions }: { actions: CostSavingAction[] }) {
  const [expanded, setExpanded] = useState(false)
  const workspace = currentWorkspace.value

  useEffect(() => {
    if (workspace !== null && vscode) {
      vscode.postMessage({ type: 'getInstructionFiles', workspace })
    }
  }, [workspace])

  if (actions.length === 0) return null

  const shown = expanded ? actions : actions.slice(0, 3)

  return (
    <div data-save-money>
      <div style="display:flex;flex-direction:column;gap:10px">
        {shown.map(a => {
          const tip = actionTipFor(a)
          return (
            <div key={a.id} style="display:flex;gap:8px;align-items:flex-start;font-size:12px">
              <span
                style="display:inline-flex;align-items:center;justify-content:center;flex-shrink:0"
                {...(tip ? { title: tip, 'data-tip-html': true, tabIndex: 0, role: 'img', 'aria-label': tip.replace(/<[^>]+>/g, '').replace(/\n/g, ' ') } : {})}
              >
                <ActionIcon a={a} />
              </span>
              <div>
                <div style="font-weight:600">
                  {a.title}
                  {a.limitPts !== undefined
                    ? <span style="font-weight:400;color:var(--muted);margin-left:6px" title="Estimated waste converted into points of your weekly plan limit, from how much of the window your past traces used per dollar of work">≈ {fmtPts(a.limitPts)} of weekly limit</span>
                    : a.estimatedUsd !== undefined
                      ? <span style="font-weight:400;color:var(--muted);margin-left:6px">≈ ${a.estimatedUsd.toFixed(2)}</span>
                      : null}
                </div>
                <div style="color:var(--muted);margin:2px 0">{a.evidence}</div>
                <div>{a.action}</div>
                {a.sessionIds.length > 0 && (
                  <button
                    type="button"
                    class="link-btn"
                    style="margin-top:3px;font-size:11px"
                    onClick={() => showLimitTraces(a.sessionIds, `for “${a.title}”`)}
                  >Show {a.sessionIds.length} trace{a.sessionIds.length === 1 ? '' : 's'} →</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {actions.length > 3 && (
        <button
          class="link-btn"
          style="margin-top:8px;font-size:11px"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? 'Show fewer' : `Show ${actions.length - 3} more`}
        </button>
      )}
    </div>
  )
}

/** Advisor's pending count, shown on Recommendations in its menu and on Analytics › Efficiency:
 *  "how to spend less" actions plus pending instruction-file suggestions, under the current filters. */
export const advisorPendingCount = computed(() => {
  const sessions = filteredSessions.value
  if (sessions.length === 0) return 0
  const existingText = instructionFiles.value.map(f => f.content).join('\n')
  return getCostSavingActions(sessions, existingText, planUsage.value).length + pendingInstructionCount(sessions)
})

export function Patterns() {
  const sessions = filteredSessions.value

  if (sessions.length === 0) {
    return <div id="patterns-content" class="empty-state">No traces recorded yet. Advice appears once you have trace history.</div>
  }

  const view = advisorView.value
  const existingText = instructionFiles.value.map(f => f.content).join('\n')
  const actions = view === 'recommendations' ? getCostSavingActions(sessions, existingText, planUsage.value) : []
  const items: ViewNavItem<AdvisorView>[] = [
    { id: 'recommendations', label: 'Recommendations',   hint: 'What to change, ranked', badge: advisorPendingCount.value },
    { id: 'instructions',    label: 'Instruction files', hint: 'Per-repo files and readiness' },
    { id: 'results',         label: 'Results',           hint: 'Did the changes work?' },
  ]
  const plan = forAgentFilter(planUsage.value, selectedAgentFilter.value)

  return (
    <div id="patterns-content">
      <ViewNav label="Advisor views" title="Advisor" items={items} active={view} onSelect={setAdvisorView}>
        {view === 'recommendations' && (
          <div data-view-panel="recommendations">
            <ViewHeader title="Recommendations" question="What should I change to spend less, and what belongs in my instruction files?" />
            <RepoFilterHint />
            {actions.length > 0 && (
              <ViewSection id="advisor-save-money" title={actions.some(a => a.limitPts !== undefined) ? 'How to use less of your limit' : 'How to spend less'}>
                <SaveMoneyCard actions={actions} />
              </ViewSection>
            )}
            <ViewSection id="advisor-instructions" title="Instruction file suggestions">
              <Instructions part="suggestions" />
            </ViewSection>
          </div>
        )}
        {view === 'instructions' && (
          <div data-view-panel="instructions">
            <ViewHeader title="Instruction files" question="Which repos have the instruction files their agents need?" />
            <ViewSection id="advisor-instruction-files" title="Files by repo">
              <Instructions part="files" />
            </ViewSection>
          </div>
        )}
        {view === 'results' && (
          <div data-view-panel="results">
            <ViewHeader title="Results" question="Did the suggestions I applied work?" />
            {hasPlanData(plan) && (
              <ViewSection id="advisor-fixes-chart" title="Did my fixes work?">
                <PlanFixesChart snapshot={plan} />
              </ViewSection>
            )}
            <ViewSection id="advisor-applied" title="Applied suggestions">
              <Instructions part="results" />
            </ViewSection>
          </div>
        )}
      </ViewNav>
    </div>
  )
}
