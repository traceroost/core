/**
 * The core edition's Org panel (see media/src/orgPanel.ts): TraceRoost with no Pro code built in.
 * Same exports as media/src/cloud/panels/OrgPanel.tsx — typed against it, so the two can't drift —
 * but the button and panel render nothing, the signals never change, and no message is sent or
 * handled. Must not import runtime code from media/src/cloud/ (type-only imports are erased).
 */

import { signal } from '@preact/signals'
import type * as Full from './cloud/panels/OrgPanel'

export type { OrgIndicator, OrgEnvironment, EnvironmentSource, CloudRate, TraceSendStats, OrgStatus } from './cloud/panels/OrgPanel'

// Only what App.tsx and tabs/Pricing.tsx use; the panel's other signals have no reader outside it.
export const orgOpen: typeof Full.orgOpen = signal(false)
export const orgStatus: typeof Full.orgStatus = signal(null)

export const displayOrgName: typeof Full.displayOrgName = (st) => (st.orgName && st.orgName !== st.orgId ? st.orgName : 'your org')
export const requestOrgStatus: typeof Full.requestOrgStatus = () => {}
export const handleOrgPanelMessage: typeof Full.handleOrgPanelMessage = () => false
export function OrgButton(): null { return null }
export function OrgPanel(): null { return null }
