ALTER TABLE ios_installations ADD COLUMN code_expires_at DATETIME(3) NULL;

UPDATE ios_installations
SET code_expires_at = TIMESTAMPADD(MINUTE, 15, UTC_TIMESTAMP(3))
WHERE code_expires_at IS NULL;

UPDATE ios_install_sessions s JOIN ios_installations i ON i.id = s.installation_id
SET s.expires_at = LEAST(s.expires_at, i.code_expires_at)
WHERE i.code_expires_at IS NOT NULL;

UPDATE ios_downloads d JOIN ios_signing_jobs j ON j.id = d.job_id
JOIN ios_installations i ON i.id = j.installation_id
SET d.expires_at = LEAST(d.expires_at, i.code_expires_at)
WHERE i.code_expires_at IS NOT NULL;
