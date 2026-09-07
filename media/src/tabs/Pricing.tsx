import { PRICING_LAST_UPDATED, RATES, PRICING_SECTIONS, REQUEST_BILLING_SOURCES, type ModelRates } from '../pricing'

// Table styling matches the established convention duplicated per-component across
// the codebase (see Help.tsx's CostSection, Cost.tsx) rather than a shared import.
const tblStyle = 'width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px'
const thStyle = 'text-align:left;padding:5px 10px 5px 0;border-bottom:2px solid var(--border);color:var(--muted);font-size:11px;text-transform:uppercase;font-weight:600;white-space:nowrap'
const tdStyle = 'padding:5px 10px 5px 0;border-bottom:1px solid var(--border);vertical-align:top'
const tdBold  = tdStyle + ';font-weight:600;color:var(--fg);white-space:nowrap;font-family:var(--vscode-editor-font-family,monospace)'
const tdNum   = tdStyle + ';white-space:nowrap;font-variant-numeric:tabular-nums'

// Rate tables use fixed 2-decimal formatting (matching PRICING_SOURCES.md's own
// tables) rather than fmtUsd's variable-precision cost-total formatting, which reads
// oddly for small per-token rates (e.g. "$0.020" instead of "$0.02").
function fmtRate(v: number): string {
  return v === 0 ? '—' : '$' + v.toFixed(2)
}

function fmtMult(v: number): string {
  if (v === 0) return '—'
  const s = v % 1 === 0 ? v.toFixed(0) : v.toString()
  return s + '×'
}

function SourceLinks({ sources }: { sources: { label: string; url: string }[] }) {
  return (
    <span style="font-size:11px;color:var(--muted)">
      {sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && ' · '}
          <a href={s.url} target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;text-underline-offset:2px">{s.label}</a>
        </span>
      ))}
    </span>
  )
}

function RatesTable({ modelKeys }: { modelKeys: string[] }) {
  const hasTier = (r: ModelRates) => r.inputAbove200kPerMTok !== undefined
  const anyTiered = modelKeys.some(k => RATES[k] && hasTier(RATES[k]))
  const anyPromo = modelKeys.some(k => RATES[k] && RATES[k].promoNote)

  return (
    <>
      <table style={tblStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Model</th>
            <th style={thStyle}>Input</th>
            <th style={thStyle}>Cache Read</th>
            <th style={thStyle}>Cache Write</th>
            <th style={thStyle}>Output</th>
            <th style={thStyle}>Request ×</th>
            <th style={thStyle}>Annual ×</th>
          </tr>
        </thead>
        <tbody>
          {modelKeys.map(key => {
            const r = RATES[key]
            if (!r) return null
            return (
              <tr key={key}>
                <td style={tdBold}>
                  {key}
                  {hasTier(r) ? <sup style="margin-left:2px;color:var(--muted)">†</sup> : null}
                  {r.promoNote ? <sup title={r.promoNote} style="margin-left:2px;color:var(--muted);cursor:help">‡</sup> : null}
                </td>
                <td style={tdNum}>{fmtRate(r.inputPerMTok)}</td>
                <td style={tdNum}>{fmtRate(r.cacheReadPerMTok)}</td>
                <td style={tdNum}>{fmtRate(r.cacheWritePerMTok)}</td>
                <td style={tdNum}>{fmtRate(r.outputPerMTok)}</td>
                <td style={tdNum}>{fmtMult(r.multiplier)}</td>
                <td style={tdNum}>{fmtMult(r.multiplierAnnualPostJun1)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {anyTiered && (
        <div style="font-size:10px;color:var(--muted);margin:-4px 0 12px">
          † Tiered — a higher rate applies above 200K tokens in a single call. Not broken out in this table; see <code>PRICING_SOURCES.md</code> for the full tier.
        </div>
      )}
      {anyPromo && (
        <div style="font-size:10px;color:var(--muted);margin:-4px 0 12px">
          ‡ Promotional pricing — hover the marker for the vendor's own note on the rate and its stated window. Not guaranteed permanent; see <code>PRICING_SOURCES.md</code> for details.
        </div>
      )}
    </>
  )
}

export function Pricing() {
  const assignedKeys = new Set(PRICING_SECTIONS.flatMap(s => s.modelKeys))
  const unassignedKeys = Object.keys(RATES).filter(k => !assignedKeys.has(k))

  return (
    <div id="pricing-content" style="padding:16px;max-width:960px">
      <div style="font-size:11px;background:var(--hover);border:1px solid var(--border);border-left:3px solid var(--warning,#ffb74d);border-radius:4px;padding:8px 10px;margin-bottom:20px;line-height:1.6;color:var(--muted);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span><strong style="color:var(--fg)">Estimates only</strong> — this is the exact rate table AgentLens uses to estimate cost, nothing hidden or approximated for display. Actual billing may differ; see each vendor's own invoice.</span>
        <span style="white-space:nowrap">Rates last updated: {PRICING_LAST_UPDATED}</span>
      </div>

      <p style="font-size:12px;color:var(--muted);line-height:1.6;margin:0 0 8px">
        All USD rates are per 1M tokens. <strong style="color:var(--fg)">Request ×</strong> and <strong style="color:var(--fg)">Annual ×</strong> are Copilot's
        per-request multipliers (× $0.04/request) — pre- and post-June 1 2026 respectively — for
        plans on request-based billing rather than token-based AI Credits; <code>—</code> means
        included/free under that billing mode. Sources for those two columns specifically:{' '}
        <SourceLinks sources={REQUEST_BILLING_SOURCES} />.
      </p>

      {PRICING_SECTIONS.map(section => (
        <div key={section.label} style="margin-top:24px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px">
            <h3 style="font-size:13px;margin:0;color:var(--fg)">{section.label}</h3>
            <span style="font-size:10px;color:var(--muted)">verified {section.verified} · <SourceLinks sources={section.sources} /></span>
          </div>
          <RatesTable modelKeys={section.modelKeys} />
        </div>
      ))}

      {unassignedKeys.length > 0 && (
        <div style="margin-top:24px">
          <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px">
            <h3 style="font-size:13px;margin:0;color:var(--fg)">Uncategorized</h3>
            <span style="font-size:10px;color:var(--muted)">
              Added to <code>RATES</code> but not yet assigned to a section above — nothing is hidden, this just needs sorting into a vendor group.
            </span>
          </div>
          <RatesTable modelKeys={unassignedKeys} />
        </div>
      )}

      <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--vscode-panel-border);font-size:11px;color:var(--muted);line-height:1.7">
        Full sourcing detail, known gaps, and per-model notes:{' '}
        <a
          href="https://github.com/traceroost/core/blob/main/PRICING_SOURCES.md"
          target="_blank" rel="noopener noreferrer"
          style="color:inherit;text-decoration:underline;text-underline-offset:2px"
        >PRICING_SOURCES.md</a>.
      </div>
    </div>
  )
}
