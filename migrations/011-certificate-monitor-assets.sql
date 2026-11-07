CREATE TABLE IF NOT EXISTS ios_device_certificate_assets (
  device_profile_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  bound_installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  secrets_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  certificate_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_monitor_assets_profile FOREIGN KEY (device_profile_id) REFERENCES customer_device_profiles(id) ON DELETE CASCADE,
  CONSTRAINT fk_monitor_assets_install FOREIGN KEY (bound_installation_id) REFERENCES ios_installations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
