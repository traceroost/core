/**
 * The one description, in this repo, of what a linked machine sends and what it refuses to send.
 *
 * This list is the argument. It is rendered verbatim by the Org panel (AL 01), printed above
 * every `--explain-payload` run (AL 03), and must match — word for word — the OAuth consent
 * screen (`cloud` `src/lib/privacy.ts` `SENT` / `NEVER_SENT`) and the invite email. A test
 * (`src/test/cloud/org/privacy.test.ts`) pins the wording so the three copies cannot drift; when
 * the `cloud` repo and this one are reconciled, that test becomes a cross-repo fixture check
 * (OPEN-QUESTIONS CC-1).
 *
 * Grounding: `cloud/docs/decisions/0003-what-we-can-and-cannot-see.md`.
 */

/** What a rollup carries. Every item is a count, an enum, a hash, or a time. Only what is
 *  actually sent today: cost is computed by the service from the token counts (never sent), and
 *  git commit / turnover records have wire shapes (`buildCommitRecords.ts`, schema) but no caller
 *  — add them back here, in both repos, in the same change that starts sending them. "files
 *  changed, lines added and removed" are the session's own agent-authored edit counts
 *  (`src/editStats.ts`), and "programming-language names" are the fixed ids of `src/language.ts`. */
export const SENT: readonly string[] = [
  'Usage counts — traces, turns, tool calls, tokens, files changed, lines added and removed',
  'Model, agent and programming-language names, with timestamps',
  'Hashed repository, branch and file ids — one-way, from your own clone',
  'Instruction-file line counts and how often sessions read each file',
  'Loop and error categories (never a message)',
]

/** What never leaves the machine. There is no wire field that could hold it. */
export const NEVER_SENT: readonly string[] = [
  'Prompts, completions, diffs and file contents',
  'File paths, repository and branch names',
  'Commit messages and raw commit SHAs',
]

/** Rendered wherever the panel or CLI needs to name who sees the data. Word for word the OAuth
 *  consent screen's "Who sees what" line (`cloud` `src/lib/privacy.ts` `whoSeesWhat`). */
export function whoSeesWhat(perDeveloperVisibility: boolean, orgName: string): string {
  return perDeveloperVisibility
    ? `${orgName} has per-developer numbers turned on — an admin sees your individual figures. Other members, including a developer individually granted org visibility, see only what ${orgName}'s teammate-visibility settings allow. You will see a marker saying so.`
    : `Admins of ${orgName} see org totals only. Your individual numbers stay yours unless the whole org turns that on.`
}

export const LEAVE_HINT = 'Unlink anytime, and instantly, with `traceroost org leave` or the Unlink button.'
