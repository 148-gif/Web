-- Preparation only. Run explicitly against a NEW, EMPTY MySQL 8.4+ database
-- after reviewing a migration plan. This file is not executed by the server.
-- MariaDB is not an equivalent target: utf8mb4_0900_bin is deliberate.
-- This binary NO_PAD collation preserves case, accents, Unicode normalization,
-- and trailing spaces used in complete-row compare-and-swap checks. JSON stays
-- text: MySQL's JSON type can rewrite its representation and change Git hashes.
-- No IF NOT EXISTS: an existing/partial target must fail, not be silently reused.
-- DDL commits implicitly in MySQL. Import row operations separately in a
-- transaction; validate target emptiness/schema before doing so.

CREATE TABLE drafts (
  path VARCHAR(768) NOT NULL PRIMARY KEY,
  content MEDIUMTEXT NULL,
  deleted TINYINT UNSIGNED NOT NULL DEFAULT 0,
  base_sha CHAR(40) NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(40) NOT NULL,
  CHECK (deleted IN (0, 1)),
  CHECK ((deleted = 0 AND content IS NOT NULL) OR (deleted = 1 AND content IS NULL AND base_sha IS NOT NULL)),
  CHECK (created_at <= 9007199254740991 AND updated_at BETWEEN created_at AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts BIGINT UNSIGNED NOT NULL,
  email VARCHAR(254) NULL,
  name VARCHAR(40) NULL,
  action VARCHAR(80) NOT NULL,
  path MEDIUMTEXT NULL,
  summary MEDIUMTEXT NULL,
  sha CHAR(40) NULL,
  INDEX log_ts (ts),
  -- MySQL does not permit CHECK expressions referencing AUTO_INCREMENT columns.
  -- The planner validates imported IDs; the adapter must check generated IDs too.
  CHECK (ts <= 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE media (
  id VARCHAR(128) NOT NULL PRIMARY KEY,
  name MEDIUMTEXT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  mime VARCHAR(100) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  store VARCHAR(16) NOT NULL,
  `key` VARCHAR(768) NOT NULL,
  status VARCHAR(16) NOT NULL,
  email VARCHAR(254) NOT NULL,
  by_name VARCHAR(40) NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  CHECK (kind IN ('photo', 'image', 'video', 'audio', 'doc')),
  CHECK (store IN ('github', 'r2')),
  CHECK (status IN ('uploading', 'receiving', 'staged', 'published', 'removing')),
  CHECK (size BETWEEN 1 AND 9007199254740991 AND created_at <= 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE media_chunks (
  id VARCHAR(128) NOT NULL,
  n BIGINT UNSIGNED NOT NULL,
  data MEDIUMTEXT NOT NULL,
  PRIMARY KEY (id, n),
  CHECK (n <= 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
-- No FK/CASCADE is introduced: the current worker explicitly orders reservation
-- and chunk cleanup. The planner rejects orphan chunks before import.

CREATE TABLE ai_usage (
  day CHAR(10) NOT NULL,
  email VARCHAR(254) NOT NULL,
  n BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, email),
  CHECK (n <= 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE editors_kv (
  `key` VARCHAR(32) NOT NULL PRIMARY KEY,
  value MEDIUMTEXT NOT NULL,
  CHECK (`key` IN ('people', 'editors', 'owner-names')),
  CHECK (JSON_VALID(value))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE request_limits (
  scope VARCHAR(80) NOT NULL PRIMARY KEY,
  window_start BIGINT UNSIGNED NOT NULL,
  n BIGINT UNSIGNED NOT NULL,
  clients MEDIUMTEXT NOT NULL DEFAULT ('{}'),
  CHECK (window_start <= 9007199254740991 AND n <= 9007199254740991),
  CHECK (JSON_VALID(clients))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
