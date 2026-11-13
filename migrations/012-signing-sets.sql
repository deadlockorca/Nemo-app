CREATE TABLE IF NOT EXISTS ios_signing_sets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  notes VARCHAR(2000) NOT NULL DEFAULT '',
  state ENUM('active','archived') NOT NULL DEFAULT 'active',
  secrets_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  certificate_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata JSON NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_signing_set_certificate (certificate_sha256),
  INDEX idx_signing_set_state (state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Inventory associations, never a claim that an IPA was installed.
CREATE TABLE IF NOT EXISTS ios_signing_set_devices (
  signing_set_id BIGINT UNSIGNED NOT NULL,
  device_profile_id BIGINT UNSIGNED NOT NULL,
  linked_udid VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (signing_set_id, device_profile_id),
  CONSTRAINT fk_signing_set_link_set FOREIGN KEY (signing_set_id) REFERENCES ios_signing_sets(id) ON DELETE CASCADE,
  CONSTRAINT fk_signing_set_link_device FOREIGN KEY (device_profile_id) REFERENCES customer_device_profiles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
