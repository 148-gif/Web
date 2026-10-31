-- Optional Node-only Google setup addon. Apply only with the explicit reviewed
-- setup command after the existing content and local authentication schemas.
-- No IF NOT EXISTS: existing or partial setup requires inspection.

CREATE TABLE google_auth_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  revision BIGINT UNSIGNED NOT NULL,
  active_version BIGINT UNSIGNED NOT NULL,
  active_client_id VARCHAR(255) NULL,
  pending_client_id VARCHAR(255) NULL,
  pending_nonce_hash CHAR(64) NULL,
  pending_session_hash CHAR(64) NULL,
  pending_user_id CHAR(32) NULL,
  pending_user_version BIGINT UNSIGNED NOT NULL,
  pending_owner_hash CHAR(64) NULL,
  pending_issued_at BIGINT UNSIGNED NOT NULL,
  pending_expires_at BIGINT UNSIGNED NOT NULL,
  verified_until BIGINT UNSIGNED NOT NULL,
  CHECK (id = 1),
  CHECK (revision BETWEEN 1 AND 9007199254740991),
  CHECK (active_version BETWEEN 1 AND 9007199254740991),
  CHECK (pending_user_version <= 9007199254740991 AND pending_issued_at <= 9007199254740991 AND pending_expires_at <= 9007199254740991 AND verified_until <= 9007199254740991),
  CHECK ((pending_client_id IS NULL AND pending_nonce_hash IS NULL AND pending_session_hash IS NULL AND pending_user_id IS NULL AND pending_user_version = 0 AND pending_owner_hash IS NULL AND pending_issued_at = 0 AND pending_expires_at = 0 AND verified_until = 0) OR
         (pending_client_id IS NOT NULL AND pending_session_hash IS NOT NULL AND pending_user_id IS NOT NULL AND pending_user_version > 0 AND pending_owner_hash IS NOT NULL AND pending_issued_at > 0 AND pending_expires_at > pending_issued_at AND
          ((pending_nonce_hash IS NOT NULL AND verified_until = 0) OR (pending_nonce_hash IS NULL AND verified_until > 0 AND verified_until <= pending_expires_at))))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

INSERT INTO google_auth_config
  (id, revision, active_version, active_client_id, pending_client_id, pending_nonce_hash, pending_session_hash, pending_user_id, pending_user_version, pending_owner_hash, pending_issued_at, pending_expires_at, verified_until)
  VALUES (1, 1, 1, NULL, NULL, NULL, NULL, NULL, 0, NULL, 0, 0, 0);
