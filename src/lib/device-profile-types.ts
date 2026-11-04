export type DeviceProfile = {
  id: string; customer_id: string; customer_name: string; license_id: string | null;
  label: string; model: string | null; apple_udid: string; signing_label: string | null;
  certificate_expires_at: string | null; profile_expires_at: string | null;
  installation_id: string | null; notes: string | null; version: number;
  key_hint: string | null; key_expires_at: string | null; key_status: string | null;
  fingerprint: string | null; last_seen_at: string | null; created_at: string;
};
export type DeviceProfileList = { items: DeviceProfile[]; total: number; page: number; pages: number };
export type ProfileInspection = {
  profileName: string; team: string; udids: string[]; profileExpiresAt: string;
  certificateExpiresAt: string | null;
};
