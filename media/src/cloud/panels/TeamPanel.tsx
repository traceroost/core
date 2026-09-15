import { signal } from '@preact/signals'
import { useEffect, useState } from 'preact/hooks'
import { vscode, goToHelp } from '../../state'

// ── The one description of the payload promise ──────────────────────────────
// Mirrors src/team/privacy.ts, which mirrors the OAuth consent screen. A test on the extension
// side (src/test/team/privacy.test.ts) pins the source-of-truth copy; this is the render of it.
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

export type TeamIndicator = 'unlinked' | 'reporting' | 'queued' | 'degraded'
export type TeamEnvironment = 'production' | 'stage' | 'test'
export type EnvironmentSource = 'env-url' | 'env-var' | 'selected' | 'default' | 'linked' | 'release'

export interface TeamStatus {
  linked: boolean
  clientVersion: string
  indicator: TeamIndicator
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
  environment: TeamEnvironment | 'custom'
  environmentSource: EnvironmentSource
  environmentEditable: boolean
}

/** `orgName` is never unset once linked — it falls back to the raw `orgId` at link time if the
 *  roster fetch failed (see `refreshOrgNameIfStale`, which self-heals this in the background).
 *  Until that succeeds, show a friendly placeholder instead of a 36-character UUID. */
function displayOrgName(st: Pick<TeamStatus, 'orgName' | 'orgId'>): string {
  return st.orgName && st.orgName !== st.orgId ? st.orgName : 'your team'
}

const ENVIRONMENT_LABEL: Record<TeamEnvironment | 'custom', string> = {
  production: 'Production',
  stage: 'Stage',
  test: 'Test',
  custom: 'Custom',
}

function environmentSourceNote(source: EnvironmentSource): string {
  switch (source) {
    case 'env-url': return 'set by TRACEROOST_TEAM_URL'
    case 'env-var': return 'set by TRACEROOST_TEAM_ENV (.env or shell)'
    case 'selected': return 'chosen below'
    case 'default': return 'default'
    case 'linked': return 'from this machine’s link'
    case 'release': return 'fixed in this build'
  }
}

export const teamOpen = signal(false)
export const teamStatus = signal<TeamStatus | null>(null)
export const teamPayloadPreview = signal<{ text: string; sessionLabel: string } | null>(null)
export const teamBusy = signal<null | 'link' | 'leave'>(null)

const DOT_COLOR: Record<TeamIndicator, string> = {
  unlinked: 'var(--muted)',
  reporting: '#56D364',
  queued: '#f6a623',
  degraded: '#f14c4c',
}

export function requestTeamStatus(): void {
  vscode?.postMessage({ type: 'getTeamStatus' })
}

function IconUsers() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

export function TeamButton() {
  const st = teamStatus.value
  const indicator: TeamIndicator = st?.indicator ?? 'unlinked'
  const active = teamOpen.value
  const title = !st || indicator === 'unlinked'
    ? 'Team — not linked, nothing is being sent'
    : indicator === 'reporting'
      ? `Team — linked to ${displayOrgName(st)}, reporting`
      : indicator === 'queued'
        ? `Team — linked, ${st.queueDepth ?? 0} trace(s) queued`
        : `Team — linked, last send failed`
  return (
    <div style="position:relative;display:flex;align-items:center">
      <button
        class={'icon-btn' + (active ? ' active' : '')}
        title={title}
        onClick={() => { teamOpen.value = !teamOpen.value; if (teamOpen.value) requestTeamStatus() }}
      ><IconUsers /></button>
      <span style={`position:absolute;top:3px;right:2px;width:7px;height:7px;border-radius:50%;background:${DOT_COLOR[indicator]};box-shadow:0 0 0 1.5px var(--vscode-editor-background)`} />
    </div>
  )
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:6px">{title}</div>
      {children}
    </div>
  )
}

function Dot({ indicator }: { indicator: TeamIndicator }) {
  return <span style={`display:inline-block;width:7px;height:7px;border-radius:50%;background:${DOT_COLOR[indicator]};margin-right:6px;flex-shrink:0`} />
}

function PayloadPreview() {
  const preview = teamPayloadPreview.value
  const [requested, setRequested] = useState(false)
  return (
    <div style="margin-top:8px">
      <button
        onClick={() => { setRequested(true); vscode?.postMessage({ type: 'teamExplainPayload' }) }}
        style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
      >Show the exact payload</button>
      {requested && !preview && <div style="font-size:11px;color:var(--muted);margin-top:6px">Building it from your most recent session…</div>}
      {preview && (
        <div style="margin-top:8px">
          <div style="font-size:10px;color:var(--muted);margin-bottom:4px">Exact bytes for your last session ({preview.sessionLabel}) — this, and nothing else, goes over the wire:</div>
          <pre style="font-size:10px;line-height:1.45;background:var(--vscode-editorWidget-background);border:1px solid var(--border);border-radius:4px;padding:8px;overflow:auto;max-height:280px;white-space:pre">{preview.text}</pre>
        </div>
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

const ENVIRONMENTS: TeamEnvironment[] = ['production', 'stage', 'test']

function EnvironmentPicker({ st }: { st: TeamStatus }) {
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
              onClick={() => vscode?.postMessage({ type: 'teamSetEnvironment', environment: env })}
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

function UnlinkedBody({ st }: { st: TeamStatus }) {
  const busy = teamBusy.value
  return (
    <>
      <Section title="This machine">
        <div style="font-size:12px;color:var(--fg);line-height:1.5">
          TraceRoost is working exactly as it does now. <strong>Nothing is being sent anywhere.</strong> There is
          no account, no telemetry and no network connection to any service.
        </div>
        <EnvironmentPicker st={st} />
      </Section>
      <Section title="If you linked this machine to a team">
        <SentNeverSent />
        <div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.5">
          Your lead sees team totals only, by default. Leaving is one click, and instant.
        </div>
        <div style="margin-top:8px">
          <a onClick={() => goToHelp('help-team')} style="font-size:11px;color:var(--vscode-textLink-foreground,#4fc3f7);cursor:pointer;text-decoration:underline">
            How the hashing works, and what Team linking does →
          </a>
        </div>
        <PayloadPreview />
      </Section>
      <Section title="Link">
        <button
          disabled={busy !== null}
          onClick={() => { teamBusy.value = 'link'; vscode?.postMessage({ type: 'teamLink' }) }}
          style="font-size:12px;padding:6px 14px;border:none;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer;font-weight:600"
        >{busy === 'link' ? 'Opening your browser…' : 'Link this machine'}</button>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">Opens your browser once. Headless box? Run <code>traceroost team link --device</code>.</div>
      </Section>
    </>
  )
}

function LinkedBody({ st }: { st: TeamStatus }) {
  const busy = teamBusy.value
  return (
    <>
      <Section title="Team">
        <div style="font-size:13px;font-weight:600;color:var(--fg)">{displayOrgName(st)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">You are <strong>{st.role ?? 'a member'}</strong> · {st.email ?? `member ${short(st.memberId)}`}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.5">
          {st.perDeveloperVisibility
            ? `${displayOrgName(st)} shows individual numbers to your lead — this team turned that on.`
            : `Your lead sees team totals only, by default. Individual numbers stay private.`}
        </div>
      </Section>
      <Section title="Status">
        <div style="display:flex;align-items:center;font-size:11px;padding:2px 0">
          <Dot indicator={st.indicator} />
          <span style="color:var(--fg)">
            {st.indicator === 'reporting' ? 'Reporting — up to date'
              : st.indicator === 'queued' ? `Queued — ${st.queueDepth ?? 0} trace(s) waiting to send`
              : `Paused — ${st.degradedReason ?? 'last send failed'}`}
          </span>
        </div>
        <Row k="Last trace" v={st.lastRollupAt ? new Date(st.lastRollupAt).toLocaleString() : 'none yet'} />
        <Row k="Environment" v={ENVIRONMENT_LABEL[st.environment]} />
        <Row k="Endpoint" v={st.endpoint ?? ''} />
        <Row k="TraceRoost version" v={`v${st.clientVersion}`} />
        <Row k="Linked" v={st.linkedAt ? new Date(st.linkedAt).toLocaleDateString() : ''} />
      </Section>
      <Section title="What is being sent">
        <SentNeverSent />
        <div style="margin-top:8px">
          <a onClick={() => goToHelp('help-team')} style="font-size:11px;color:var(--vscode-textLink-foreground,#4fc3f7);cursor:pointer;text-decoration:underline">
            How the hashing works, and what Team linking does →
          </a>
        </div>
        <PayloadPreview />
      </Section>
      <Section title="Team view">
        <button
          onClick={() => vscode?.postMessage({ type: 'teamOpenView' })}
          style="font-size:11px;padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
        >Open team view →</button>
      </Section>
      <Section title="Leave">
        <button
          disabled={busy !== null}
          onClick={() => { teamBusy.value = 'leave'; vscode?.postMessage({ type: 'teamLeave' }) }}
          style="font-size:12px;padding:6px 14px;border:1px solid var(--border);border-radius:4px;background:transparent;color:var(--fg);cursor:pointer"
        >{busy === 'leave' ? 'Leaving…' : 'Leave team'}</button>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">Deletes the local credential and stops forwarding immediately — even offline.</div>
      </Section>
    </>
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

export function TeamPanel() {
  const open = teamOpen.value
  const st = teamStatus.value

  useEffect(() => {
    if (!open) return
    requestTeamStatus()
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') teamOpen.value = false }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div style={`position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--vscode-editor-background);border-left:1px solid var(--border);z-index:200;overflow-y:auto;transition:transform 0.2s ease;transform:${open ? 'translateX(0)' : 'translateX(100%)'};box-shadow:-4px 0 20px rgba(0,0,0,0.4)`}>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--vscode-editor-background);z-index:1">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--muted)">Team{st?.linked ? ' — linked' : ''}</span>
        <button onClick={() => teamOpen.value = false} style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0 4px;line-height:1" title="Close (Esc)">×</button>
      </div>
      {!st && <div style="padding:16px;font-size:12px;color:var(--muted)">Checking this machine's status — locally, no network…</div>}
      {st && !st.linked && <UnlinkedBody st={st} />}
      {st && st.linked && <LinkedBody st={st} />}
    </div>
  )
}
