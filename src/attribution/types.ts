/**
 * AI authorship attribution (AL 05) — free forever, local, single-developer.
 *
 * Decides, for every line in a commit, whether an agent wrote it, and how confident that is.
 * Everything downstream (AL 06 turnover, AL 07 report) is a ratio whose numerator this produces.
 */

export type Confidence = 'certain' | 'probable' | 'unknown'

/** A commit with its per-file line counts, from `git log --numstat`. */
export interface ScannedCommit {
  sha: string
  authoredAt: string        // ISO 8601
  authorEmail: string
  isMerge: boolean
  subjectHadAgentTrailer: boolean
  /** repo-relative POSIX path → { added, removed } for this commit. */
  files: Record<string, { added: number; removed: number }>
  linesAdded: number
  linesRemoved: number
}

/** The narrow view of a local session the join needs. No prompt/response text. */
export interface AttributionSession {
  sessionId: string
  /** Absolute workspace path (or file: URI) recorded for the session. */
  workspace: string
  startMs: number
  endMs: number
  /** Absolute paths of files the session changed. */
  filesChanged: string[]
}

export interface CommitAttribution {
  sha: string
  authoredAt: string
  linesAdded: number
  linesRemoved: number
  /** Lines this commit introduced, in agent-touched files, that blame attributes to this commit. */
  aiLines: number
  attribution: Confidence
  /** Session ids that contributed to the attribution (for the local hand-off, never sent). */
  sessionIds: string[]
  isMerge: boolean
}

/** Coverage is reported, never assumed: unknown lines are excluded from the denominator. */
export interface AttributionCoverage {
  attributedLines: number   // lines in commits with attribution `certain` or `probable`
  totalMergedLines: number  // lines added across every commit in the window
}
