/**
 * The three tables backing the Outcomes tab's caching (AL 05/06) — attribution, cohort turnover,
 * and the per-file blame cache. Exported on its own, separately from SCHEMA_SQL, so the standalone
 * server can open a small dedicated database with just these tables rather than the full
 * sessions/timelines/instructions schema it has no other use for (it persists those as JSON, not
 * SQLite — see standalone/db/outcomesDb.ts).
 */
export const OUTCOMES_SCHEMA_SQL = `
-- AI authorship attribution cache (AL 05). A commit's attribution never changes once computed,
-- so this is written once per commit for the life of the install. Keyed by repo_root + sha.
-- Holds only counts and an enum — never commit message text, never blame output.
CREATE TABLE IF NOT EXISTS commit_attribution (
  repo_root      TEXT NOT NULL,
  sha            TEXT NOT NULL,
  authored_at    TEXT NOT NULL,
  lines_added    INTEGER NOT NULL DEFAULT 0,
  lines_removed  INTEGER NOT NULL DEFAULT 0,
  ai_lines       INTEGER NOT NULL DEFAULT 0,
  attribution    TEXT NOT NULL DEFAULT 'unknown',
  session_ids    TEXT NOT NULL DEFAULT '[]',
  is_merge       INTEGER NOT NULL DEFAULT 0,
  computed_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  PRIMARY KEY (repo_root, sha)
);

-- Cohort turnover report (AL 06), one row per repository. Recomputed only when HEAD has moved —
-- the row records the HEAD sha it was computed at. Holds counts and a rate; nothing reversible.
CREATE TABLE IF NOT EXISTS cohort_turnover (
  repo_root     TEXT PRIMARY KEY,
  head_sha      TEXT NOT NULL,
  report_json   TEXT NOT NULL,
  computed_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- Per-file blame cache for the survival index (AL 06) — the expensive part of turnover is one
-- git-blame subprocess per file at HEAD, aggregated by originating commit. A single new commit
-- used to invalidate all of it (cohort_turnover is all-or-nothing, keyed by HEAD sha); this table
-- makes that incremental — a file is only re-blamed when its blob_sha (content) actually changed.
-- Holds only counts keyed by commit sha, same privacy posture as commit_attribution: never blame
-- output, never file content.
CREATE TABLE IF NOT EXISTS file_blame (
  repo_root    TEXT NOT NULL,
  file_path    TEXT NOT NULL,
  blob_sha     TEXT NOT NULL,
  origins_json TEXT NOT NULL,
  computed_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  PRIMARY KEY (repo_root, file_path)
);

-- Per-session git-outcome classification (productive/reverted/abandoned/ambiguous) shown as the
-- Sessions tab's outcome pill (gitOutcome.ts). Shelling out to git per changed file is the
-- expensive part, so this follows cohort_turnover's convention: recomputed only when the repo's
-- HEAD has moved since the stored row, not on every restart. Holds only counts/enums, never diff
-- or file content.
CREATE TABLE IF NOT EXISTS git_outcome (
  session_id   TEXT PRIMARY KEY,
  repo_root    TEXT NOT NULL,
  head_sha     TEXT NOT NULL,
  overall      TEXT NOT NULL,
  files_json   TEXT NOT NULL DEFAULT '{}',
  reason       TEXT NOT NULL DEFAULT '',
  computed_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- What each session's git_outcome cache key (resolveOutcomeCacheKey) was last built from: the HEAD
-- and trunk-tip shas its pass read once per repo root, a hash of its in-repo file list, and the
-- resulting "git log -1 <head> -- <files>" sha. A later pass whose root HEAD and file list are
-- unchanged reuses file_sha instead of spawning git per session. The working-tree digest part of
-- the key is always recomputed from disk. Holds only the repo root, shas and hashes -- never file
-- paths or content.
CREATE TABLE IF NOT EXISTS git_outcome_key (
  session_id     TEXT PRIMARY KEY,
  repo_root      TEXT NOT NULL,
  head_sha       TEXT NOT NULL,
  trunk_sha      TEXT NOT NULL,
  rel_paths_hash TEXT NOT NULL,
  file_sha       TEXT NOT NULL,
  cache_key      TEXT NOT NULL,
  computed_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- Canonical trace revision (staged feature 10, Stage 1, generalized). One durable monotonic
-- revision number per session, allocated when either of two independent dimensions changes:
-- the classified git outcome (fingerprint/outcome_overall, written by recordCheck) or the
-- content of the full allowlisted cloud-forwarded projection (payload_hash, written by
-- recordPayloadHash -- see reconcile/payloadHash.ts). A reparse of identical evidence on either
-- dimension updates checked_at only, so it never creates forwarding work or a false
-- "something changed" signal. fingerprint is git_outcome's own cache key (resolveOutcomeCacheKey)
-- at the time the outcome dimension was last recorded. payload_hash is a canonical sha256 of the
-- last-hashed SessionRollup (excluding its own revision field). Either write preserves the other
-- dimension's stored value -- see traceRevisionRepository.ts. Lifecycle is reserved for future
-- active/idle/completed tracking; this pass only ever writes 'active'. source_rank (staged feature
-- 11) is the rank of the last content-hashed snapshot: a lower-rank snapshot of the same key is
-- never forwarded over it (traceIdentity.ts).
CREATE TABLE IF NOT EXISTS trace_revision (
  session_id         TEXT PRIMARY KEY,
  revision           INTEGER NOT NULL,
  lifecycle          TEXT    NOT NULL DEFAULT 'active',
  fingerprint         TEXT    NOT NULL,
  outcome_overall     TEXT,
  payload_hash        TEXT,
  checked_at          INTEGER NOT NULL,
  changed_at          INTEGER NOT NULL,
  source_rank         INTEGER
);

-- Single global monotonic counter backing trace_revision.revision. One process (the editor's
-- extension host, or the standalone server) owns its own on-disk database and therefore its own
-- counter -- there is deliberately no attempt here to serialize revision allocation *across* the
-- two processes when both are pointed at the same workspace; see reconciliationService.ts's doc
-- comment for why that is out of scope for the current sql.js-backed storage layer.
CREATE TABLE IF NOT EXISTS trace_revision_counter (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  next INTEGER NOT NULL DEFAULT 1
);

-- Subscription plan-limit readings (Claude Pro/Max, ChatGPT plans): how full the 5-hour and weekly
-- windows were at a moment, read from files the agent CLIs write themselves (Codex rollout
-- token_count events; Claude Code's cached reading in ~/.claude.json). See src/planUsage/.
-- Percentages, timestamps and a salted account hash only -- never a credential or account id.
-- Follows trace retention.
CREATE TABLE IF NOT EXISTS limit_readings (
  provider      TEXT    NOT NULL,
  account_hash  TEXT    NOT NULL DEFAULT '',
  window_kind   TEXT    NOT NULL,
  used_pct      REAL    NOT NULL,
  resets_at     INTEGER,
  observed_at   INTEGER NOT NULL,
  source        TEXT    NOT NULL,
  session_id    TEXT,
  plan_type     TEXT,
  PRIMARY KEY (provider, account_hash, window_kind, observed_at, source)
);
CREATE INDEX IF NOT EXISTS idx_limit_readings_observed ON limit_readings (observed_at);

-- Plan limits hit (a request refused until the window resets). Follows trace retention.
CREATE TABLE IF NOT EXISTS limit_hits (
  provider      TEXT    NOT NULL,
  session_id    TEXT    NOT NULL,
  window_kind   TEXT    NOT NULL,
  hit_at        INTEGER NOT NULL,
  resets_at     INTEGER,
  PRIMARY KEY (provider, session_id, window_kind, hit_at)
);

-- The latest plan status per provider (plan type, credit state, spend cap), for plans that report
-- no 5-hour or weekly window -- e.g. a ChatGPT Business Codex account, metered in credits. One row
-- per provider, replaced by newer observations. Follows trace retention.
CREATE TABLE IF NOT EXISTS limit_plan_status (
  provider          TEXT    PRIMARY KEY,
  plan_type         TEXT,
  observed_at       INTEGER NOT NULL,
  no_windows        INTEGER NOT NULL,
  has_credits       INTEGER,
  unlimited_credits INTEGER,
  credit_balance    TEXT,
  limit_reached     INTEGER NOT NULL DEFAULT 0,
  session_id        TEXT
);

-- One row per completed plan window, written when its reset is detected: the peak it reached and
-- whether a limit was hit. Kept 12 months regardless of trace retention -- it's what the
-- week-over-week chart reads once the raw readings have aged out.
CREATE TABLE IF NOT EXISTS limit_window_rollups (
  provider      TEXT    NOT NULL,
  account_hash  TEXT    NOT NULL DEFAULT '',
  window_kind   TEXT    NOT NULL,
  window_end    INTEGER NOT NULL,
  peak_pct      REAL    NOT NULL,
  hit           INTEGER NOT NULL DEFAULT 0,
  coverage      TEXT    NOT NULL,
  PRIMARY KEY (provider, account_hash, window_kind, window_end)
);
`

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  trace_id            TEXT NOT NULL,
  source              TEXT NOT NULL,
  workspace           TEXT NOT NULL,
  project_path        TEXT,
  model               TEXT NOT NULL DEFAULT '',
  start_time          INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  turns               INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  cache_hit_rate      REAL    NOT NULL DEFAULT 0,
  total_tool_calls    INTEGER NOT NULL DEFAULT 0,
  total_llm_calls     INTEGER NOT NULL DEFAULT 0,
  errors              INTEGER NOT NULL DEFAULT 0,
  outcome             TEXT    NOT NULL DEFAULT 'unknown',
  is_sidechain        INTEGER NOT NULL DEFAULT 0,
  initiator           TEXT,
  speed               TEXT,
  user_request        TEXT    NOT NULL DEFAULT '',
  tool_counts         TEXT    NOT NULL DEFAULT '{}',
  loop_signals        TEXT    NOT NULL DEFAULT '[]',
  files_read          TEXT    NOT NULL DEFAULT '[]',
  files_changed       TEXT    NOT NULL DEFAULT '[]',
  files_written       TEXT    NOT NULL DEFAULT '[]',
  files_searched      TEXT    NOT NULL DEFAULT '[]',
  files_changed_note  TEXT,
  cost_usd            REAL    NOT NULL DEFAULT 0,
  data_source         TEXT    NOT NULL DEFAULT 'otel',
  models              TEXT    NOT NULL DEFAULT '[]',
  one_shot_stats      TEXT    NOT NULL DEFAULT '{}',
  conversation_id     TEXT,
  language            TEXT,
  language_secondary  TEXT,
  files_changed_count INTEGER,
  lines_added         INTEGER,
  lines_removed       INTEGER,
  derived             INTEGER NOT NULL DEFAULT 0,
  legacy              INTEGER NOT NULL DEFAULT 0,
  source_rank         INTEGER,
  subagent_count      INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions (start_time DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_source     ON sessions (source);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace  ON sessions (workspace);

CREATE TABLE IF NOT EXISTS timeline_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  span_id       TEXT    NOT NULL,
  position      INTEGER NOT NULL,
  type          TEXT    NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  model         TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cache_read_tokens   INTEGER,
  cache_create_tokens INTEGER,
  ttft          INTEGER,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  action        TEXT,
  decision      TEXT,
  is_error      INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  timestamp     TEXT    NOT NULL DEFAULT '',
  speed         TEXT,
  has_blob      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline_entries (session_id, position);

CREATE TABLE IF NOT EXISTS edit_details (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  timeline_entry_id INTEGER NOT NULL REFERENCES timeline_entries(id) ON DELETE CASCADE,
  file_path         TEXT    NOT NULL DEFAULT '',
  tool_name         TEXT,
  has_blob          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_edit_details_entry ON edit_details (timeline_entry_id);

CREATE TABLE IF NOT EXISTS instruction_applied (
  id                     TEXT PRIMARY KEY,
  workspace              TEXT NOT NULL,
  category               TEXT NOT NULL,
  title                  TEXT NOT NULL,
  suggested_text         TEXT NOT NULL DEFAULT '',
  applied_to             TEXT NOT NULL DEFAULT '',
  applied_text           TEXT NOT NULL DEFAULT '',
  applied_at             TEXT NOT NULL,
  baseline_cost_avg      REAL NOT NULL DEFAULT 0,
  baseline_turns_avg     REAL NOT NULL DEFAULT 0,
  baseline_error_rate    REAL NOT NULL DEFAULT 0,
  baseline_loop_rate     REAL NOT NULL DEFAULT 0,
  baseline_insufficient  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_instruction_applied_workspace ON instruction_applied (workspace);

CREATE TABLE IF NOT EXISTS instruction_dismissed (
  id           TEXT NOT NULL,
  workspace    TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (id, workspace)
);

CREATE INDEX IF NOT EXISTS idx_instruction_dismissed_workspace ON instruction_dismissed (workspace);

-- One row per successful forwarding drain (the Cloud upload sender's recordSent), not per trace —
-- a drain can send up to batchLimit (200) items in one round trip, so this stores the batch's
-- count rather than inserting once per item. Backs the Team panel's "hashed traces sent" transport
-- stats (last 5 min / last hour / all time): summing count where sent_at is within a window gives
-- an exact count with one row per drain instead of one per trace, at negligible size long-term.
CREATE TABLE IF NOT EXISTS trace_sends (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at INTEGER NOT NULL,
  count   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_trace_sends_sent_at ON trace_sends (sent_at);

-- Stable trace identity (staged feature 11): an id a trace was stored or sent under before it got
-- its canonical key (a whole-file or 30-minute-gap log row, an OTEL span id, and each one's wire
-- uuid) -> that key. Deep links and lookups by an old id resolve through it. Opaque ids only.
CREATE TABLE IF NOT EXISTS trace_aliases (
  old_id      TEXT PRIMARY KEY,
  new_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_trace_aliases_new ON trace_aliases (new_id);

-- One row once the one-time local re-key (database/traceKeyMigration.ts) has run.
CREATE TABLE IF NOT EXISTS trace_key_migration (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  version  INTEGER NOT NULL,
  done_at  INTEGER NOT NULL
);

${OUTCOMES_SCHEMA_SQL}
`
