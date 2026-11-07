CREATE TABLE IF NOT EXISTS ios_certificate_checks (
  certificate_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  status ENUM('unknown','good','revoked','expired') NOT NULL DEFAULT 'unknown',
  detail_code VARCHAR(60) NOT NULL DEFAULT 'not_checked',
  method VARCHAR(8) NULL,
  checked_at DATETIME(3) NULL,
  last_confirmed_status ENUM('good','revoked','expired') NULL,
  last_confirmed_at DATETIME(3) NULL,
  response_valid_until DATETIME(3) NULL,
  next_check_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  incident INT UNSIGNED NOT NULL DEFAULT 0,
  claim_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  claim_until DATETIME(3) NULL,
  INDEX idx_certificate_check_due (next_check_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ios_certificate_alerts (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  dedupe_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  kind ENUM('revoked','expired','expiry_1','expiry_3','expiry_7') NOT NULL,
  certificate_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  device_profile_id BIGINT UNSIGNED NULL,
  source_installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  generation VARCHAR(190) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','sending','sent','cancelled') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claim_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  claim_until DATETIME(3) NULL,
  last_error VARCHAR(60) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  INDEX idx_certificate_alert_due (status, next_attempt_at),
  CONSTRAINT fk_certificate_alert_profile FOREIGN KEY (device_profile_id) REFERENCES customer_device_profiles(id) ON DELETE CASCADE,
  CONSTRAINT fk_certificate_alert_install FOREIGN KEY (source_installation_id) REFERENCES ios_installations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ios_certificate_monitor_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  heartbeat_at DATETIME(3) NULL,
  mail_configured BOOLEAN NOT NULL DEFAULT FALSE,
  last_error VARCHAR(60) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO ios_certificate_monitor_state (id) VALUES (1);
