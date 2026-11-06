import { orgOpen, orgStatus, requestOrgStatus, displayOrgName } from '../orgPanel'

function openCloud() {
  orgOpen.value = true
  requestOrgStatus()
}

/**
 * The Export and Import drawers' TraceRoost Cloud note. Files carry full per-trace detail; Cloud gets
 * one rollup per trace — counts, enums, hashes and times, never prompts, code or file paths (see
 * Help's Privacy section) — so unlinked, it suggests Cloud for the team view, and linked, it
 * explains which of the two to reach for.
 */
export function CloudNote({ kind }: { kind: 'export' | 'import' }) {
  // A literal edition check (esbuild.js defines it) so the core bundle, which has no Cloud, drops this.
  if (process.env.TRACEROOST_EDITION === 'core') return null
  const st = orgStatus.value
  const link = (label: string) => <button class="export-cloud-link" onClick={openCloud}>{label}</button>

  if (st?.linked) {
    const org = displayOrgName(st)
    return kind === 'export'
      ? <p class="export-replay-desc">
          This machine is linked to {org} on TraceRoost Cloud, which shows rollups across your team.
          For privacy, Cloud never gets prompts, code, or file paths, so export when a teammate
          needs the specifics. {link('Open Cloud')}
        </p>
      : <p class="export-cloud-note">
          {org}'s rollups are on TraceRoost Cloud. Import is for the per-trace specifics a teammate
          sends you. {link('Open Cloud')}
        </p>
  }

  return kind === 'export'
    ? <p class="export-replay-desc">
        Want to see progress across your team without passing files around? TraceRoost Cloud
        shows rollups for everyone. For privacy, it never gets prompts, code, or file paths. {link('Try TraceRoost Cloud')}
      </p>
    : <p class="export-cloud-note">
        Want team-wide rollups without exchanging files? {link('Try TraceRoost Cloud')}
      </p>
}
