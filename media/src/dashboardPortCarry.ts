// The page's half of a Settings → Dashboard port move: the address to navigate to, with the
// per-origin preferences it would otherwise lose carried in the fragment. Mirrors CARRY_KEYS and
// CARRY_FRAGMENT in standalone/dashboardPort.ts, whose inline script imports them on arrival
// (media/ can't import from standalone/ — its rootDir is src); standalone/dashboardPort.test.ts
// checks that the two key lists agree.

export const DASHBOARD_CARRY_KEYS = ['traceroost-theme', 'traceroost-sessions-page-size', 'traceRoost.agentProfiles'] as const

export function movedDashboardUrl(
  port: number,
  loc: Pick<Location, 'protocol' | 'hostname'>,
  storage: Pick<Storage, 'getItem'> | null,
): string {
  const items: Record<string, string> = {}
  for (const key of DASHBOARD_CARRY_KEYS) {
    try {
      const value = storage?.getItem(key)
      if (typeof value === 'string') items[key] = value
    } catch { /* storage unavailable — nothing to carry */ }
  }
  const carry = encodeURIComponent(JSON.stringify({ moved: port, items }))
  return `${loc.protocol}//${loc.hostname}:${port}/#carry=${carry}`
}
