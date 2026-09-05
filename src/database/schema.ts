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
`
