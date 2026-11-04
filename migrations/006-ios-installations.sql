CREATE TABLE IF NOT EXISTS ios_installations (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  license_id BIGINT UNSIGNED NOT NULL,
  label VARCHAR(120) NOT NULL,
  apple_udid VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  source_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  secrets_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata JSON NOT NULL,
  state ENUM('active','revoked') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ios_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ios_signing_jobs (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  status ENUM('queued','signing','ready','failed') NOT NULL DEFAULT 'queued',
  attempt INT UNSIGNED NOT NULL DEFAULT 1,
  claim_token CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  heartbeat_at DATETIME(3) NULL,
  output_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  output_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(60) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  CONSTRAINT fk_ios_job_install FOREIGN KEY (installation_id) REFERENCES ios_installations(id) ON DELETE CASCADE,
  INDEX idx_ios_queue (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ios_install_sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_ios_session_install FOREIGN KEY (installation_id) REFERENCES ios_installations(id) ON DELETE CASCADE,
  INDEX idx_ios_session_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ios_downloads (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  job_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_ios_download_job FOREIGN KEY (job_id) REFERENCES ios_signing_jobs(id) ON DELETE CASCADE,
  INDEX idx_ios_download_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ios_install_limits (
  bucket CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  window_start DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
