import type { CertificateStatus, CertificateMonitorSummary } from "./certificate-monitor-types";
export type DeviceProfile = {
  id: string; customer_id: string; customer_name: string; license_id: string | null;
  label: string; model: string | null; apple_udid: string; signing_label: string | null;
  certificate_expires_at: string | null; profile_expires_at: string | null;
  certificate_monitor_attached?: boolean;
  certificate_status?: CertificateStatus; certificate_detail?: string;
  certificate_checked_at?: string | null; certificate_last_confirmed_status?: string | null;
  certificate_last_confirmed_at?: string | null; certificate_valid_until?: string | null;
  certificate_next_check_at?: string | null;
  installation_id: string | null; notes: string | null; version: number;
  key_hint: string | null; key_expires_at: string | null; key_status: string | null;
  fingerprint: string | null; last_seen_at: string | null; created_at: string;
};
export type DeviceProfileList = { items: DeviceProfile[]; total: number; page: number; pages: number; monitor?: CertificateMonitorSummary };
export type ProfileInspection = {
  profileName: string; team: string; udids: string[]; profileExpiresAt: string;
  certificateExpiresAt: string | null;
};
