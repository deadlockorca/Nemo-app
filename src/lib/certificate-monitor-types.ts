export type CertificateStatus = "good" | "revoked" | "expired" | "unknown";
export type CertificateResult = { status: CertificateStatus; detail: string; method: "ocsp" | "crl" | null; validUntil: string | null };
export type CertificateMonitorSummary = { enabled: boolean; stale: boolean; heartbeat_at: string | null; mail_configured: boolean; mail_failed: boolean; pending: number; last_error: string | null };
export const certificateLabels = { good: "Chưa bị thu hồi", revoked: "Đã thu hồi", expired: "Đã hết hạn", unknown: "Chưa xác minh được" };
export const certificateDetails: Record<string, string> = {
  not_checked: "Đang chờ lượt kiểm tra đầu tiên.", no_status_endpoint: "Chưa có địa chỉ kiểm tra được hỗ trợ.",
  ocsp_unverified: "Không nhận được phản hồi OCSP hợp lệ.", crl_unverified: "Không nhận được danh sách thu hồi hợp lệ.",
  invalid_assets_or_response: "Chưa xác minh được bộ ký hoặc phản hồi Apple.", source_unavailable: "Chưa đọc được bộ ký đã lưu.",
  checker_unavailable: "Công cụ kiểm tra chưa sẵn sàng.", stale: "Kết quả đã cũ; cần kiểm tra tiến trình theo dõi.",
  no_assets: "Chưa có profile để kiểm tra online. Dùng Theo dõi chứng chỉ để gắn.", certificate_expired: "Chứng chỉ đã hết hạn.",
  profile_expired: "Profile đã hết hạn.", verified: "Đã xác minh phản hồi có chữ ký. Không bảo đảm mọi điều kiện cài app đều hợp lệ.",
};
