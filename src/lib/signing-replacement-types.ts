export type ReplacementStatus = 'queued' | 'signing' | 'ready' | 'issued' | 'failed' | 'cancelled';
export type ReplacementContext = {
  device: { id: string; label: string; apple_udid: string; version: number; customer_name: string; license_id: string | null };
  sets: { id: string; name: string; version: number; certificate_sha256: string }[];
  releases: { id: string; label: string; version: number }[];
  history: { id: string; status: ReplacementStatus; set_name: string; release_label: string; old_certificate: string | null; new_certificate: string; created_at: string; issued_at: string | null; error: string | null; installation_id: string | null }[];
};
export const replacementLabels: Record<ReplacementStatus, string> = { queued: 'Chờ ký', signing: 'Đang ký và xác minh', ready: 'Sẵn sàng cấp link', issued: 'Đã cấp bản cài mới', failed: 'Ký không thành công', cancelled: 'Đã hủy' };
