import { goToHelp } from '../state'
import { openAgentSetup } from './Settings'

/** The "nothing recorded yet" empty state's next steps: point the agents at TraceRoost, or read
 *  how setup works. Shared by the Traces and Analytics tabs. */
export function NoTracesYet() {
  return (
    <>
      <div>No traces recorded yet.</div>
      <div class="empty-state-next">
        <button type="button" class="link-btn" onClick={openAgentSetup}>Set up agents</button>
        <span aria-hidden="true"> · </span>
        <button type="button" class="link-btn" onClick={() => goToHelp('help-config')}>Getting started</button>
      </div>
    </>
  )
}
