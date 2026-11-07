import { orgOpen, orgStatus, requestOrgStatus, displayOrgName } from '../orgPanel'
import { CLOUD_INFO_URL } from '../cloudInfo'

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
export function CloudNote({ kind }: { kind: 'export' | 'import' | 'analytics' }) {
  // A literal edition check (esbuild.js defines it): the core bundle, which has no Cloud and can't
  // link, keeps only a plain link to the public page (CoreCloudNote) and drops everything below.
  if (process.env.TRACEROOST_EDITION === 'core') return <CoreCloudNote kind={kind} />
  const st = orgStatus.value
  const link = (label: string) => <button class="export-cloud-link" onClick={openCloud}>{label}</button>
  if (kind === 'analytics') {
    // Linked, the Org panel already says where the team view is; unlinked, point at it once.
    return st?.linked ? null : (
      <p class="export-cloud-note">
        These figures cover this machine. To see them across your whole team, without anyone's
        prompts or code leaving their machine, {link('try TraceRoost Cloud')}.
      </p>
    )
  }

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

/**
 * The core edition's only mention of TraceRoost Cloud: a link to its public page, opened in the
 * browser like Help's other external links. No Cloud code, no request — this build can't link.
 */
function CoreCloudNote({ kind }: { kind: 'export' | 'import' | 'analytics' }) {
  const link = <a href={CLOUD_INFO_URL} target="_blank" rel="noreferrer">TraceRoost Cloud</a>
  if (kind === 'analytics') {
    return (
      <p class="export-cloud-note">
        These figures cover this machine. To see them across your whole team, without anyone's
        prompts or code leaving their machine, see {link}.
      </p>
    )
  }
  return kind === 'export'
    ? <p class="export-replay-desc">
        Want your team's figures in one place without passing files around? {link} shows rollups
        for every developer, and never gets prompts, code, or file paths.
      </p>
    : <p class="export-cloud-note">
        Want team-wide rollups without exchanging files? See {link}.
      </p>
}
