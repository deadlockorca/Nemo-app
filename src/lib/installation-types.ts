import type { IpaMetadata } from "./ipa-release-types";
export type PackageMetadata = IpaMetadata & {
  team: string; certificateSha256: string; certificateExpiresAt: string;
  profileName: string; profileExpiresAt: string; profileDeviceCount: number;
  signingMode: "development" | "ad-hoc";
};
export type InstallationItem = {
  id: string; license_id: string; label: string; apple_udid: string; state: string;
  customer_name: string; key_hint: string; metadata: PackageMetadata;
  job_status: string | null; error_code: string | null; created_at: string;
  code_expires_at: string | null; code_expired: number;
  release_id: string | null; release_label: string | null;
};
export type CustomerInstall = {
  label: string; deviceSuffix: string; version: string; status: string;
  error: string | null; development: boolean;
  expiresAt: string; expiresIn: number;
};
export const signingErrors: Record<string, string> = {
  certificate_not_verified: "Chưa xác minh được chứng chỉ hợp lệ qua Apple. Kiểm tra bộ ký và thử lại.",
  replacement_changed: "Hồ sơ, key hoặc bộ ký đã thay đổi. Tải lại dữ liệu và tạo yêu cầu mới.",
  wrong_p12_password: "Mật khẩu .p12 không đúng hoặc tệp chứng chỉ không hợp lệ.",
  certificate_expired: "Chứng chỉ chưa có hiệu lực hoặc đã hết hạn.",
  profile_expired: "Hồ sơ cấp phép chưa có hiệu lực hoặc đã hết hạn.",
  profile_has_no_devices: "Profile không có danh sách UDID thiết bị. Hãy chọn profile Development hoặc Ad Hoc dành cho máy khách.",
  device_not_in_profile: "Hồ sơ cấp phép không chứa UDID Apple của máy này.",
  certificate_profile_mismatch: "Chứng chỉ không khớp hồ sơ cấp phép.",
  invalid_profile_signature: "Chữ ký Apple của hồ sơ cấp phép không hợp lệ.",
  blank_ipa_required: "Cần chọn IPA trắng NemoBlankIdentity-1.",
  source_changed: "IPA nguồn đã thay đổi so với phiên bản đã lưu. Hãy kiểm tra kho IPA trước khi tạo bản cài.",
  embedded_identity_found: "IPA còn chứa ID nhúng sẵn. Hãy chọn IPA trắng.",
  wrong_app: "IPA phải có tên Nemo và bundle vn.fractal.nemo-rebuild.",
  unsafe_ipa: "Nội dung ZIP của IPA không an toàn hoặc bị hỏng.",
  invalid_ipa: "Không đọc được IPA.",
  unsupported_ipa: "IPA có cấu trúc chưa được hỗ trợ.",
  ipa_too_large: "Dung lượng giải nén của IPA vượt giới hạn.",
  signing_tool_failed: "Công cụ ký chưa xử lý được gói. Hãy kiểm tra bộ chứng chỉ và máy ký.",
  security_import_failed: "Máy ký chưa nhập được bộ chứng chỉ. Hãy liên hệ người cấp mã để kiểm tra máy ký.",
  unsupported_signer: "Máy chủ chưa được cấu hình bộ ký phù hợp. Hãy liên hệ người cấp mã.",
  linux_signer_unavailable: "Bộ ký trên máy chủ chưa sẵn sàng. Hãy liên hệ người cấp mã.",
  signer_python_unavailable: "Công cụ xử lý bản cài trên máy chủ chưa sẵn sàng. Hãy liên hệ người cấp mã.",
  zsign_failed: "Máy chủ chưa ký được bản cài. Hãy liên hệ người cấp mã để kiểm tra bộ chứng chỉ.",
  signature_verification_failed: "Bản cài chưa vượt qua kiểm tra chữ ký. Hãy liên hệ người cấp mã.",
  macos_signer_required: "Cần chạy máy ký trên macOS.",
  worker_interrupted: "Lần chuẩn bị trước bị gián đoạn. Bạn có thể thử lại.",
};
export function signingError(code: string | null) {
  return signingErrors[code || ""] || "Chưa thể chuẩn bị bản cài. Hãy liên hệ người cấp mã hoặc thử lại.";
}
