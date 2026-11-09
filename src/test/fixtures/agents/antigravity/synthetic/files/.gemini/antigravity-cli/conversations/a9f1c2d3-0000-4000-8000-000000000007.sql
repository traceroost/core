-- SYNTHETIC: an invented Antigravity CLI conversation database. The DDL is agy 1.0.7-1.0.10's,
-- byte-for-byte as agentsview recorded it (so the schema fingerprint is the known 1ca98426f561);
-- the gen_metadata / executor_metadata blobs are protobuf encoded from the field numbers in
-- src/adapters/antigravity/proto.ts. Built into <id>.db beside this file by the contract suite.
CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`));
CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));
CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));
CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));
CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));
CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`));
CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));
CREATE INDEX `idx_steps_status` ON `steps`(`status`);
CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`);
PRAGMA user_version = 1;
INSERT INTO steps (idx, step_type) VALUES (0, 14);
INSERT INTO steps (idx, step_type) VALUES (1, 21);
INSERT INTO steps (idx, step_type) VALUES (2, 15);
INSERT INTO steps (idx, step_type) VALUES (3, 17);
INSERT INTO steps (idx, step_type) VALUES (4, 15);
INSERT INTO steps (idx, step_type) VALUES (5, 17);
INSERT INTO steps (idx, step_type) VALUES (6, 15);
INSERT INTO steps (idx, step_type) VALUES (7, 14);
INSERT INTO steps (idx, step_type) VALUES (8, 15);
INSERT INTO steps (idx, step_type) VALUES (9, 17);
INSERT INTO steps (idx, step_type) VALUES (10, 15);
INSERT INTO steps (idx, step_type) VALUES (11, 14);
INSERT INTO gen_metadata (idx, data, size) VALUES (1, X'0a24220908fc0710e01218b4019a011667656d696e692d332e372d666c6173682d6578702d62120102', 41);
INSERT INTO gen_metadata (idx, data, size) VALUES (2, X'0a21220c08fc0710ac0218dc0128e0129a011067656d696e692d332e372d666c61736812020405', 39);
INSERT INTO gen_metadata (idx, data, size) VALUES (3, X'0a1c220708fc07100018009a011067656d696e692d332e372d666c617368120106', 33);
INSERT INTO gen_metadata (idx, data, size) VALUES (4, X'0a20220b08fc07109601185a288c159a011067656d696e692d332e372d666c617368120106', 37);
INSERT INTO gen_metadata (idx, data, size) VALUES (5, X'0a21220c08fc0710f40318ac0228b8179a011067656d696e692d332e372d666c61736812020809', 39);
INSERT INTO gen_metadata (idx, data, size) VALUES (6, X'0a26220a08fc071078183c28ac1baa011747656d696e6920332e3720466c6173682028486967682912010a', 43);
INSERT INTO executor_metadata (idx, data) VALUES (1, X'1806521a0a18e2011567656d696e692d332e372d666c6173682d68696768');
INSERT INTO executor_metadata (idx, data) VALUES (2, X'180a521c0a1ae2011767656d696e692d332e372d666c6173682d6d656469756d');
