-- OpenCode opencode.db as LogReader._parseOpenCodeDb reads it: the tables and JSON paths it
-- queries (schema confirmed 2026-06-10, see src/test/logReader.opencode.test.ts). Every value is
-- invented. The contract test builds the database from this file with sql.js.
CREATE TABLE session (
  id TEXT PRIMARY KEY, parent_id TEXT, title TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL DEFAULT '',
  model TEXT, time_created INTEGER NOT NULL DEFAULT 0, time_updated INTEGER NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);

INSERT INTO session VALUES ('ses_1', NULL, 'Rename a variable', '<REPO>', '{"id":"claude-opus-4-1","providerID":"anthropic"}', 1759312800000, 1759312860000, 1500, 210, 0, 900, 120);

INSERT INTO message VALUES ('msg_u1', 'ses_1', 1759312800000, '{"role":"user","time":{"created":1759312800000}}');
INSERT INTO message VALUES ('msg_a1', 'ses_1', 1759312801000, '{"role":"assistant","parentID":"msg_u1","time":{"created":1759312801000,"completed":1759312805000},"tokens":{"input":900,"output":150,"reasoning":0,"cache":{"read":500,"write":120}}}');
INSERT INTO message VALUES ('msg_a2', 'ses_1', 1759312806000, '{"role":"assistant","parentID":"msg_u1","time":{"created":1759312806000,"completed":1759312809000},"tokens":{"input":600,"output":60,"reasoning":0,"cache":{"read":400,"write":0}}}');

INSERT INTO part VALUES ('prt_1', 'msg_u1', 'ses_1', 1759312800000, '{"type":"text","text":"rename foo to bar in src/a.ts"}');
INSERT INTO part VALUES ('prt_2', 'msg_a1', 'ses_1', 1759312801500, '{"type":"step-start"}');
INSERT INTO part VALUES ('prt_3', 'msg_a1', 'ses_1', 1759312802000, '{"type":"tool","tool":"edit","callID":"call_1","state":{"status":"completed","input":{"filePath":"<REPO>/src/a.ts"},"output":"ok"}}');
INSERT INTO part VALUES ('prt_4', 'msg_a1', 'ses_1', 1759312805000, '{"type":"step-finish"}');
INSERT INTO part VALUES ('prt_5', 'msg_a2', 'ses_1', 1759312807000, '{"type":"text","text":"Renamed."}');
