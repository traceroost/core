import { signal } from '@preact/signals'
import { useEffect } from 'preact/hooks'
import { vscode, goToHelp } from '../../state'

// ── The one description of the payload promise ──────────────────────────────
// Mirrors src/cloud/org/privacy.ts, which mirrors the OAuth consent screen. A test on the extension
// side (src/test/cloud/org/privacy.test.ts) pins the source-of-truth copy; this is the render of it.
const SENT = [
  'Usage counts — traces, turns, tool calls, tokens, cost',
  'Model and agent names, with timestamps',
  'Hashed commit and file ids — one-way, from your own clone',
  'Line counts: added, removed, AI-authored, surviving',
  'Loop and error categories (never a message)',
]
const NEVER_SENT = [
  'Prompts, completions, diffs and file contents',
  'File paths, repository and branch names',
  'Commit messages and raw commit SHAs',
]

export type OrgIndicator = 'unlinked' | 'reporting' | 'queued' | 'degraded'
export type OrgEnvironment = 'production' | 'stage' | 'test'
export type EnvironmentSource = 'env-url' | 'env-var' | 'selected' | 'default' | 'linked' | 'release'

/** The four flat per-MTok rates the cloud effective-rates endpoint knows how to serve — mirrors
 *  `src/pricing.ts`'s `ModelRates` minus the tiered/long-context fields it doesn't model. */
export interface CloudRate {
  inputPerMTok: number
  cacheReadPerMTok: number
  cacheWritePerMTok: number
  outputPerMTok: number
}

export interface TraceSendStats {
  last5Min: number
  lastHour: number
  allTime: number
}

export interface OrgStatus {
  linked: boolean
  clientVersion: string
  indicator: OrgIndicator
  endpoint?: string
  orgId?: string
  orgName?: string
  memberId?: string
  email?: string
  role?: 'lead' | 'member'
  perDeveloperVisibility?: boolean
  linkedAt?: string
  queueDepth?: number
  lastRollupAt?: string | null
  degradedReason?: string
  environment: OrgEnvironment | 'custom'
  environmentSource: EnvironmentSource
  environmentEditable: boolean
  /** Org-provided rates (pricingSync.ts) currently overriding the local rate table, keyed by
   *  normalizeCostKey — empty on an unlinked install or before the first successful sync. */
  cloudRateOverrides: Record<string, CloudRate>
  traceSendStats?: TraceSendStats
  /** True only while a drain is actually in flight — the state dot blinks for this, not for
   *  `indicator === 'reporting'` on its own (a fully-synced, idle state is a solid dot). */
  sending: boolean
}

/** `orgName` is never unset once linked — it falls back to the raw `orgId` at link time if the
 *  roster fetch failed (see `refreshOrgNameIfStale`, which self-heals this in the background).
 *  Until that succeeds, show a friendly placeholder instead of a 36-character UUID. */
export function displayOrgName(st: Pick<OrgStatus, 'orgName' | 'orgId'>): string {
  return st.orgName && st.orgName !== st.orgId ? st.orgName : 'your org'
}

const ENVIRONMENT_LABEL: Record<OrgEnvironment | 'custom', string> = {
  production: 'Production',
  stage: 'Stage',
  test: 'Test',
  custom: 'Custom',
}

function environmentSourceNote(source: EnvironmentSource): string {
  switch (source) {
    case 'env-url': return 'set by TRACEROOST_ORG_URL'
    case 'env-var': return 'set by TRACEROOST_ORG_ENV (.env or shell)'
    case 'selected': return 'chosen below'
    case 'default': return 'default'
    case 'linked': return 'from this machine’s link'
    case 'release': return 'fixed in this build'
  }
}

export const orgOpen = signal(false)
export const orgStatus = signal<OrgStatus | null>(null)
export const orgPayloadPreview = signal<Array<{ text: string; sessionLabel: string }> | null>(null)
export const orgBusy = signal<null | 'link' | 'leave'>(null)
export const orgReconcileResult = signal<{ queued: number; error?: string } | null>(null)
export const orgReconcileBusy = signal(false)
/** Populated while a reconcile is running, from `orgReconcileProgress` messages — lets the
 *  button show real progress instead of a static "Checking…" on installs with enough local
 *  history for this to take a while (see `reconcileLocalSessions` in panelController.ts). */
export const orgReconcileProgress = signal<{ done: number; total: number } | null>(null)
/** Mirrors `orgReconcileBusy` for the payload-preview button — lifted out of the component so
 *  an `orgError` reply (panelController threw before it could post a `orgPayloadPreview`) can
 *  clear it from the central message dispatcher in App.tsx, the same way it clears the others. */
export const orgPayloadBusy = signal(false)

const DOT_COLOR: Record<OrgIndicator, string> = {
  unlinked: 'var(--muted)',
  reporting: '#56D364',
  queued: '#f6a623',
  degraded: '#f14c4c',
}

export function requestOrgStatus(): void {
  vscode?.postMessage({ type: 'getOrgStatus' })
}

function IconCloud() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  )
}

export function OrgButton() {
  const st = orgStatus.value
  const indicator: OrgIndicator = st?.indicator ?? 'unlinked'
  const sending = st?.sending ?? false
  const active = orgOpen.value
  return (
    <div style="position:relative;display:flex;align-items:center">
      <button
        class={'icon-btn' + (active ? ' active' : '')}
        onClick={() => { orgOpen.value = !orgOpen.value; if (orgOpen.value) requestOrgStatus() }}
      ><IconCloud /></button>
      <span style={`position:absolute;top:3px;right:2px;width:7px;height:7px;border-radius:50%;background:${DOT_COLOR[indicator]};box-shadow:0 0 0 1.5px var(--vscode-editor-background)${sending ? ';animation:tr-pulse 1.4s ease-in-out infinite' : ''}`} />
    </div>
  )
}

function Section({ title, children }: { title?: string; children: preact.ComponentChildren }) {
  return (
    <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
      {title && <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:6px">{title}</div>}
      {children}
    </div>
  )
}

function Dot({ indicator, sending }: { indicator: OrgIndicator; sending?: boolean }) {
  return <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${DOT_COLOR[indicator]};margin-right:6px;flex-shrink:0${sending ? ';animation:tr-pulse 1.4s ease-in-out infinite' : ''}`} />
}

/** On-demand answer to "did everything actually make it?" — queues anything not yet confirmed
 *  delivered (cheap: the delivery ledger means an already-sent session costs one file read, not
 *  a resend) and reports back how many were missing. Complements the automatic reconciliation
 *  that already runs at link time and on every restart's log rediscovery — this is for checking
 *  right now, without waiting for either. */
function ReconcileButton({ queueDepth }: { queueDepth: number }) {
  const busy = orgReconcileBusy.value
  const progress = orgReconcileProgress.value
  const result = orgReconcileResult.value
  const label = busy
    ? (progress && progress.total > 0 ? `Checking… (${progress.done}/${progress.total})` : 'Checking…')
    : 'Check for unsent traces'
  return (
    <div style="margin-top:8px">
      <button
        disabled={busy}
        onClick={() => {
          orgReconcileBusy.value = true
          orgReconcileProgress.value = null
          orgReconcileResult.value = null
          vscode?.postMessage({ type: 'orgReconcile' })
        }}
        style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
      >{label}</button>
      {result && (
        <span style={`font-size:11px;margin-left:8px;color:${result.error ? '#f14c4c' : 'var(--muted)'}`}>
          {result.error
            ? `Couldn't finish: ${result.error}`
            : result.queued > 0 ? `Found ${result.queued} not yet sent — queued now.`
            // This button only looks for local sessions never yet enqueued at all — a nonzero
            // queueDepth here means some are already queued but haven't been *sent*, not that
            // everything made it. Clicking still nudges the scheduler to retry them now (see
            // reconcileLocalSessions), but a persistently failing item (see the Status row above)
            // needs its own send fixed, not another click here.
            : queueDepth > 0 ? `No new sessions found — ${queueDepth} already-queued trace(s) will retry shortly.`
            : 'Everything is already sent.'}
        </span>
      )}
    </div>
  )
}

function PayloadPreview() {
  const previews = orgPayloadPreview.value
  const busy = orgPayloadBusy.value
  return (
    <div style="margin-top:8px">
      <button
        disabled={busy}
        onClick={() => { orgPayloadBusy.value = true; orgPayloadPreview.value = null; vscode?.postMessage({ type: 'orgExplainPayload' }) }}
        style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
      >{busy ? 'Building…' : 'Show example payload'}</button>
      {busy && !previews && <div style="font-size:11px;color:var(--muted);margin-top:6px">Building it from your most recent traces…</div>}
      {previews && previews.length > 0 && (
        <pre style="margin-top:8px;font-size:10px;line-height:1.45;background:var(--vscode-editorWidget-background);border:1px solid var(--border);border-radius:4px;padding:8px;overflow:auto;max-height:280px;white-space:pre">{previews.map(preview => preview.text).join('\n\n')}</pre>
      )}
    </div>
  )
}

function SentNeverSent() {
  return (
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:11px">
      <div>
        <div style="font-weight:600;color:var(--fg);margin-bottom:4px">What it would send</div>
        <ul style="margin:0;padding-left:14px;color:var(--muted);line-height:1.5">{SENT.map(s => <li key={s}>{s}</li>)}</ul>
      </div>
      <div>
        <div style="font-weight:600;color:var(--fg);margin-bottom:4px">What it never sends</div>
        <ul style="margin:0;padding-left:14px;color:var(--muted);line-height:1.5">{NEVER_SENT.map(s => <li key={s}>{s}</li>)}</ul>
      </div>
    </div>
  )
}

const ENVIRONMENTS: OrgEnvironment[] = ['production', 'stage', 'test']

function EnvironmentPicker({ st }: { st: OrgStatus }) {
  return (
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <span style="font-size:10px;color:var(--muted)">Environment</span>
        <span style="font-size:10px;color:var(--muted)">{environmentSourceNote(st.environmentSource)}</span>
      </div>
      {st.environmentEditable ? (
        <div style="display:flex;gap:4px;margin-top:4px">
          {ENVIRONMENTS.map((env) => (
            <button
              key={env}
              onClick={() => vscode?.postMessage({ type: 'orgSetEnvironment', environment: env })}
              style={`flex:1;font-size:11px;padding:4px 0;border:1px solid var(--border);border-radius:4px;cursor:pointer;background:${st.environment === env ? 'var(--vscode-button-background)' : 'transparent'};color:${st.environment === env ? 'var(--vscode-button-foreground)' : 'var(--fg)'}`}
            >{ENVIRONMENT_LABEL[env]}</button>
          ))}
        </div>
      ) : (
        <div style="font-size:12px;color:var(--fg);margin-top:4px">{ENVIRONMENT_LABEL[st.environment]}</div>
      )}
    </div>
  )
}

function UnlinkedBody({ st }: { st: OrgStatus }) {
  const busy = orgBusy.value
  return (
    <>
      <Section title="This machine">
        <div style="font-size:12px;color:var(--fg);line-height:1.5">
          TraceRoost is working exactly as it does now. <strong>Nothing is being sent anywhere.</strong> There is
          no account, no telemetry and no network connection to any service.
        </div>
        <EnvironmentPicker st={st} />
      </Section>
      <Section title="Link">
        <button
          disabled={busy !== null}
          onClick={() => { orgBusy.value = 'link'; vscode?.postMessage({ type: 'orgLink' }) }}
          style="font-size:12px;padding:6px 14px;border:none;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-weight:600"
        >{busy === 'link' ? 'Opening your browser…' : 'Link this machine'}</button>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">Opens your browser once. Headless box? Run <code>traceroost org link --device</code>.</div>
      </Section>
      <Section title="Why link">
        <ul style="margin:0;padding-left:14px;color:var(--muted);font-size:11px;line-height:1.6">
          <li>Gives your lead org-wide cost &amp; activity totals, without exposing anyone's code</li>
          <li>Team totals only by default — individual numbers stay private unless your team turns that on</li>
          <li>Opt-in and off by default; nothing is sent until you link</li>
          <li>Reversible any time — unlinking deletes the local credential and stops sending immediately, even offline</li>
          <li>Works offline — sessions queue locally and send automatically once you're back</li>
        </ul>
      </Section>
      <Section title="Data privacy">
        <SentNeverSent />
        <div style="margin-top:8px">
          <a onClick={() => goToHelp('help-privacy')} style="font-size:11px;color:var(--vscode-textLink-foreground,#4fc3f7);cursor:pointer;text-decoration:underline">
            How the hashing works, and what linking does →
          </a>
        </div>
        <PayloadPreview />
      </Section>
    </>
  )
}

function LinkedBody({ st }: { st: OrgStatus }) {
  const busy = orgBusy.value
  return (
    <>
      {/* No title, and no repeated team name — the panel's sticky header above already shows it. */}
      <Section>
        <div style="font-size:11px;color:var(--muted)">You are <strong>{st.role ?? 'a member'}</strong> · {st.email ?? `member ${short(st.memberId)}`}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.5">
          {st.perDeveloperVisibility
            ? `${displayOrgName(st)} shows individual numbers to your lead — this team turned that on.`
            : `Your lead sees team totals only, by default. Individual numbers stay private.`}
        </div>
      </Section>
      <Section title="Status">
        <div style="display:flex;align-items:center;font-size:11px;padding:2px 0">
          <Dot indicator={st.indicator} sending={st.sending} />
          <span style="color:var(--fg)">
            {st.indicator === 'reporting' ? (st.sending ? 'Sending — hashed traces going to cloud' : 'Synced — hashed traces sent to cloud')
              : st.indicator === 'queued' ? `Queued — ${st.queueDepth ?? 0} hashed trace(s) waiting to sync`
              : `Paused — ${st.degradedReason ?? 'last send failed'}`}
          </span>
        </div>
        <Row k="Last trace" v={st.lastRollupAt ? new Date(st.lastRollupAt).toLocaleString() : 'none yet'} />
        <Row k="Environment" v={ENVIRONMENT_LABEL[st.environment]} />
        <Row k="Endpoint" v={st.endpoint ?? ''} />
        <Row k="TraceRoost version" v={`v${st.clientVersion}`} />
        <Row k="Linked" v={st.linkedAt ? new Date(st.linkedAt).toLocaleDateString() : ''} />
        {st.traceSendStats && <TransportStats stats={st.traceSendStats} />}
        <ReconcileButton queueDepth={st.queueDepth ?? 0} />
      </Section>
      <Section title="What is being sent">
        <SentNeverSent />
        <div style="margin-top:8px">
          <a onClick={() => goToHelp('help-privacy')} style="font-size:11px;color:var(--vscode-textLink-foreground,#4fc3f7);cursor:pointer;text-decoration:underline">
            How the hashing works, and what linking does →
          </a>
        </div>
        <PayloadPreview />
      </Section>
      <Section title="Team view">
        <button
          onClick={() => vscode?.postMessage({ type: 'orgOpenView' })}
          style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
        >Open Team View →</button>
      </Section>
      <Section title="Unlink">
        <button
          disabled={busy !== null}
          onClick={() => { orgBusy.value = 'leave'; vscode?.postMessage({ type: 'orgLeave' }) }}
          style="font-size:12px;padding:6px 14px;border:1px solid var(--error);border-radius:4px;background:transparent;color:var(--error);cursor:pointer"
        >{busy === 'leave' ? 'Unlinking…' : 'Unlink this machine'}</button>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">Deletes the local credential and stops forwarding immediately — even offline. This only unlinks this machine; you stay a member of {displayOrgName(st)} until a lead removes you from the roster.</div>
      </Section>
    </>
  )
}

/** Transport transparency stats — how many hashed traces this machine has actually sent, over a
 *  few windows. Reads straight from this machine's own local SQLite DB (never the cloud), so it's
 *  as trustworthy an answer to "is it really only sending what it says?" as the payload preview
 *  above is. */
function TransportStats({ stats }: { stats: TraceSendStats }) {
  const cells: Array<{ label: string; value: number }> = [
    { label: 'Last 5 min', value: stats.last5Min },
    { label: 'Last hour', value: stats.lastHour },
    { label: 'All time', value: stats.allTime },
  ]
  return (
    <div style="margin-top:10px">
      <div style="font-size:11px;color:var(--muted)">Hashed traces sent</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:4px;overflow:hidden;margin-top:4px">
        {cells.map(c => (
          <div key={c.label} style="background:var(--vscode-editor-background);padding:8px 4px;text-align:center">
            <div style="font-size:16px;font-weight:600;color:var(--fg)">{c.value.toLocaleString()}</div>
            <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-top:2px">{c.label}</div>
          </div>
        ))}
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:4px">Counted locally, from this machine's own send log — never from the cloud.</div>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:2px 0">
      <span style="color:var(--muted)">{k}</span>
      <span style="color:var(--fg);text-align:right;word-break:break-all">{v}</span>
    </div>
  )
}

function short(id?: string): string {
  return id ? id.slice(0, 8) : ''
}

export function OrgPanel() {
  const open = orgOpen.value
  const st = orgStatus.value

  useEffect(() => {
    if (!open) return
    requestOrgStatus()
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') orgOpen.value = false }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div inert={!open} aria-hidden={!open} style={`visibility:${open ? 'visible' : 'hidden'};position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--vscode-editor-background);border-left:1px solid var(--border);z-index:200;overflow-y:auto;transition:transform 0.2s ease;transform:${open ? 'translateX(0)' : 'translateX(100%)'};box-shadow:-4px 0 20px rgba(0,0,0,0.4)`}>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:1">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">{st?.linked ? displayOrgName(st) : 'Not linked'}</span>
        <button onClick={() => orgOpen.value = false} style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0 4px;line-height:1" title="Close (Esc)">×</button>
      </div>
      {!st && <div style="padding:16px;font-size:12px;color:var(--muted)">Checking this machine's status — locally, no network…</div>}
      {st && !st.linked && <UnlinkedBody st={st} />}
      {st && st.linked && <LinkedBody st={st} />}
    </div>
  )
}
