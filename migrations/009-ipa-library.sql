CREATE TABLE IF NOT EXISTS ios_ipa_releases (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  label VARCHAR(120) NOT NULL,
  notes TEXT NULL,
  source_key CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  size_bytes BIGINT UNSIGNED NOT NULL,
  metadata JSON NOT NULL,
  state ENUM('active','archived') NOT NULL DEFAULT 'active',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE ios_installations
ADD COLUMN release_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
ADD CONSTRAINT fk_ios_install_release FOREIGN KEY (release_id) REFERENCES ios_ipa_releases(id);
