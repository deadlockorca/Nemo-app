export type ManagementSection = "customers" | "licenses" | "devices" | "activity";
export type ManagementRow = {
  id: string; name?: string; contact?: string | null; notes?: string | null;
  version?: number; created_at?: string; license_count?: string; device_profile_count?: string;
  customer_id?: string; customer_name?: string; key_hint?: string;
  duration_days?: number; display_status?: string; activated_at?: string | null; expires_at?: string | null;
  has_identity?: number;
  license_id?: string; fingerprint?: string; bound_at?: string; last_seen_at?: string | null;
  device_profile_id?: string | null; device_label?: string | null; apple_udid?: string | null; signing_label?: string | null;
  action?: string; target_id?: string | null; display_name?: string | null; details?: Record<string, unknown> | null;
};
export type ListData = { items: ManagementRow[]; total: number; page: number; pages: number };
export const sectionTitles: Record<ManagementSection, string> = {
  customers: "Khách hàng", licenses: "Quản lý key", devices: "Thiết bị", activity: "Lịch sử hoạt động",
};
export const actionTitles: Record<string, string> = {
  "device_profile.created": "Thêm hồ sơ thiết bị", "device_profile.updated": "Sửa hồ sơ thiết bị", "device_profile.deleted": "Xóa hồ sơ thiết bị", "device_profile.installation_linked": "Gắn bộ ký với thiết bị",
  "installation.created": "Tạo bản cài", "installation.revoked": "Thu hồi bản cài", "installation.code_rotated": "Cấp lại mã cài",
  "admin.login": "Đăng nhập quản trị", "admin.password_changed": "Đổi mật khẩu quản trị",
  "customer.created": "Thêm khách hàng", "customer.updated": "Sửa khách hàng", "customer.deleted": "Xóa khách hàng",
  "license.created": "Cấp key", "license.extended": "Gia hạn key", "license.revoked": "Thu hồi key", "license.restored": "Khôi phục key", "license.deleted": "Xóa key",
  "license.test_expired": "Kiểm thử hết hạn key", "license.test_restored": "Khôi phục key sau kiểm thử",
  "device.released": "Gỡ liên kết thiết bị", "device.activated": "Kích hoạt thiết bị",
  "license.identity_assigned": "Gán cấu hình thiết bị", "license.identity_updated": "Cập nhật cấu hình thiết bị",
};
export function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
}

export function formatRemaining(value: string, now: number | null) {
  const expiry = new Date(value).getTime();
  if (!Number.isFinite(expiry)) return "—";
  if (now === null) return "Đang tính…";
  const remaining = expiry - now;
  if (remaining <= 0) return "Đã hết hạn";
  const seconds = Math.ceil(remaining / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const clock = [hours, minutes, seconds % 60].map((part) => String(part).padStart(2, "0")).join(":");
  return days ? `${days} ngày ${clock}` : clock;
}
