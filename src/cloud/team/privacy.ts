/**
 * The one description, in this repo, of what a linked machine sends and what it refuses to send.
 *
 * This list is the argument. It is rendered verbatim by the Team panel (AL 01), printed above
 * every `--explain-payload` run (AL 03), and must match — word for word — the OAuth consent
 * screen (`alsaas` `src/lib/privacy.ts` `SENT` / `NEVER_SENT`) and the invite email. A test
 * (`src/test/team/privacy.test.ts`) pins the wording so the three copies cannot drift; when the
 * `alsaas` repo and this one are reconciled, that test becomes a cross-repo fixture check
 * (OPEN-QUESTIONS CC-1).
 *
 * Grounding: `alsaas/docs/decisions/0003-what-we-can-and-cannot-see.md`.
 */

/** What a rollup carries. Every item is a count, an enum, a hash, or a time. */
export const SENT: readonly string[] = [
  'Usage counts — traces, turns, tool calls, tokens, cost',
  'Model and agent names, with timestamps',
  'Hashed commit and file ids — one-way, from your own clone',
  'Line counts: added, removed, AI-authored, surviving',
  'Loop and error categories (never a message)',
]

/** What never leaves the machine. There is no wire field that could hold it. */
export const NEVER_SENT: readonly string[] = [
  'Prompts, completions, diffs and file contents',
  'File paths, repository and branch names',
  'Commit messages and raw commit SHAs',
]

/** Rendered wherever the panel or CLI needs to name who sees the data. */
export function whoSeesWhat(perDeveloperVisibility: boolean, orgName: string): string {
  return perDeveloperVisibility
    ? `${orgName} shows individual numbers to your lead — this team turned that on.`
    : `Your lead sees team totals only, by default. Individual numbers stay private.`
}

export const LEAVE_HINT = 'Unlink anytime, and instantly, with `traceroost team leave` or the Leave team button.'
