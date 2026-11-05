-- Apply explicitly after a database backup; the runtime never executes DDL.
CREATE TABLE local_account_profiles (
 user_id CHAR(32) NOT NULL PRIMARY KEY,
 email VARCHAR(254) NOT NULL,
 verified TINYINT UNSIGNED NOT NULL DEFAULT 0,
 UNIQUE KEY account_email (email),
 CHECK (verified IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE local_account_tokens (
 token_hash CHAR(64) NOT NULL PRIMARY KEY,
 user_id CHAR(32) NOT NULL,
 purpose VARCHAR(16) NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 expires_at BIGINT UNSIGNED NOT NULL,
 INDEX account_token_user (user_id),
 CHECK (purpose IN ('verify','password'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE local_account_mail (
 id CHAR(32) NOT NULL PRIMARY KEY,
 payload MEDIUMTEXT NOT NULL,
 attempts INT UNSIGNED NOT NULL DEFAULT 0,
 available_at BIGINT UNSIGNED NOT NULL,
 lease_until BIGINT UNSIGNED NOT NULL DEFAULT 0,
 sent_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
 created_at BIGINT UNSIGNED NOT NULL,
 INDEX account_mail_due (sent_at, available_at, lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE local_content_owners (
 path VARCHAR(512) NOT NULL PRIMARY KEY,
 user_id CHAR(32) NOT NULL,
 INDEX account_content_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
