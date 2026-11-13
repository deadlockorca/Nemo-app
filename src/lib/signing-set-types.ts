export type SigningSetMetadata = {
  certificateSha256: string; certificateExpiresAt: string; profileExpiresAt: string;
  profileUuid: string; profileName: string; team: string; applicationIdentifier: string;
  udids: string[]; signingMode: 'development' | 'ad-hoc';
};
export type SigningSet = {
  id: string; name: string; notes: string; state: 'active' | 'archived'; version: number;
  metadata: SigningSetMetadata; certificate_sha256: string;
  certificate_status: 'unknown' | 'good' | 'revoked' | 'expired'; checked_at: string | null;
  linked_count: number; observed_count: number;
};
export type SigningSetList = { items: SigningSet[]; total: number; page: number; pages: number };
export type SigningSetDevice = {
  id: string; label: string; customer_name: string; apple_udid: string; version: number;
  linked: boolean; eligible: boolean; observed: boolean; linked_udid: string | null;
};
export type SigningSetDetail = { set: SigningSet; devices: SigningSetDevice[]; total: number; page: number; pages: number };
export const signingStatus = { unknown: 'Chưa xác minh được', good: 'Hợp lệ qua Apple', revoked: 'Đã bị thu hồi', expired: 'Chứng chỉ hết hạn' };
