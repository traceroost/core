/**
 * The public page a core build points at for TraceRoost Cloud (CloudNote in the core edition, and
 * Help's Cloud section there). Like media/src/suggest.ts's SUGGEST_URL: a fixed public web page the
 * user's browser opens — nothing is sent from here, and no Cloud code ships with it — chosen at
 * build time, production in a release build and stage otherwise. scripts/check-edition.mjs allows
 * exactly these URLs (PUBLIC_LINKS) and still fails on any other Cloud hostname or endpoint. A
 * specific page, not the bare host: allowlisting `https://traceroost.com/` would also strip that
 * prefix off a Cloud endpoint URL before the marker scan.
 */
export const CLOUD_INFO_URL = process.env.TRACEROOST_RELEASE_BUILD
  ? 'https://traceroost.com/pricing'
  : 'https://stage.traceroost.com/pricing'
