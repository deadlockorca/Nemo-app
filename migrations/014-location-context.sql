ALTER TABLE customers ADD COLUMN nemo_username VARCHAR(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL;

CREATE TABLE IF NOT EXISTS license_location_policies (
  license_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  centers JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_location_policy_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS location_context_requests (
  license_id BIGINT UNSIGNED NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  context_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  response JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (license_id, request_id),
  INDEX idx_location_request_created (created_at),
  CONSTRAINT fk_location_request_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
