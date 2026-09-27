/**
 * Which build of TraceRoost this is. `full` ships TraceRoost Pro's org linking and uploading
 * (`src/cloud/**`); `core` is built without any of it — see src/cloudBridge.ts and esbuild.js's
 * `--edition` flag. Tests and unbundled runs are always `full`.
 */

/** What the core edition says wherever a Pro-only action is attempted. */
export const NOT_AVAILABLE_IN_CORE = 'Not available in the TraceRoost core edition (no org linking or uploading is built in).'
