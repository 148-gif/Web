-- Optional Node-only invitation storage. Apply only with the explicit additive
-- setup tool after a backup. Existing auth users, settings and sessions remain
-- unchanged. Runtime and HTTP routes never create or repair this table.

CREATE TABLE local_auth_invitations (
  owner_hash CHAR(64) NOT NULL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL,
  issuer_id CHAR(32) NOT NULL,
  issuer_version BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  consumed TINYINT UNSIGNED NOT NULL,
  UNIQUE KEY local_auth_invitation_token (token_hash),
  CONSTRAINT local_auth_invitation_version CHECK (issuer_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT local_auth_invitation_expiry CHECK (expires_at BETWEEN 1 AND 9007199254740991),
  CONSTRAINT local_auth_invitation_consumed CHECK (consumed IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
