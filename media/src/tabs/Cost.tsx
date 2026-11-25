import { fmtUsd } from '../sessionMetrics'

// One definition (sessionMetrics.ts) so every tab formats costs the same way; re-exported here
// for the tabs that already import it from Cost.
export { fmtUsd }
