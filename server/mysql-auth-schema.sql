-- Optional Node-only local authentication. Execute only through the explicit
-- additive setup tool after backing up the existing application database.
-- No application table is altered. Runtime and HTTP endpoints never run DDL.
-- No IF NOT EXISTS: partial setup must be investigated, never silently reused.

CREATE TABLE local_auth_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  local_enabled TINYINT UNSIGNED NOT NULL,
  google_enabled TINYINT UNSIGNED NOT NULL,
  local_verified TINYINT UNSIGNED NOT NULL,
  google_verified_until BIGINT UNSIGNED NOT NULL,
  bootstrap_hash CHAR(64) NULL,
  bootstrap_expires BIGINT UNSIGNED NOT NULL,
  bootstrap_owner_hash CHAR(64) NULL,
  bootstrap_consumed TINYINT UNSIGNED NOT NULL,
  CHECK (id = 1),
  CHECK (local_enabled IN (0, 1) AND google_enabled IN (0, 1) AND local_verified IN (0, 1)),
  CHECK (bootstrap_consumed IN (0, 1)),
  CHECK (bootstrap_consumed = 0 OR bootstrap_hash IS NULL),
  CHECK (local_enabled = 1 OR google_enabled = 1),
  CHECK (google_verified_until <= 9007199254740991 AND bootstrap_expires <= 9007199254740991),
  CHECK ((bootstrap_hash IS NULL AND bootstrap_owner_hash IS NULL AND bootstrap_expires = 0) OR
         (bootstrap_hash IS NOT NULL AND bootstrap_owner_hash IS NOT NULL AND bootstrap_expires > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE local_auth_users (
  id CHAR(32) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  display_name VARCHAR(40) NOT NULL,
  password_hash VARCHAR(256) NOT NULL,
  owner_hash CHAR(64) NOT NULL,
  role VARCHAR(16) NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  disabled TINYINT UNSIGNED NOT NULL,
  UNIQUE KEY local_auth_username (username),
  CHECK (role IN ('owner', 'editor', 'publisher')),
  CHECK (version BETWEEN 1 AND 9007199254740991),
  CHECK (disabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE local_auth_sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  csrf_hash CHAR(64) NOT NULL,
  user_id CHAR(32) NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  INDEX local_auth_session_user (user_id),
  INDEX local_auth_session_expiry (expires_at),
  CHECK (version BETWEEN 1 AND 9007199254740991),
  CHECK (expires_at BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

INSERT INTO local_auth_settings
  (id, local_enabled, google_enabled, local_verified, google_verified_until, bootstrap_hash, bootstrap_expires, bootstrap_owner_hash, bootstrap_consumed)
  VALUES (1, 0, 1, 0, 0, NULL, 0, NULL, 0);
