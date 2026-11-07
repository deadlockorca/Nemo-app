import nodemailer from "nodemailer";
export type CertificateAlertPayload = {
  title: string; expiresAt?: string; observedAt?: string; affected: { customer: string; device: string; signingLabel: string; udidSuffix: string }[];
};
function email(value: string | undefined) { return !!value && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value); }
export function mailConfig() {
  const host = process.env.SMTP_HOST || "", port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || "", pass = process.env.SMTP_PASSWORD || "";
  const from = process.env.SMTP_FROM || user, to = process.env.CERTIFICATE_ALERT_TO;
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || ![465, 587].includes(port) || !user || !pass || !email(from) || !email(to)) return null;
  return { host, port, user, pass, from, to: to! };
}
export function alertMessage(id: string, payload: CertificateAlertPayload) {
  const lines = [payload.title, "", ...(payload.observedAt ? [`Xác minh thu hồi lúc: ${payload.observedAt}`, ""] : []), ...(payload.expiresAt ? [`Hạn: ${new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(payload.expiresAt))}`, ""] : []),
    ...payload.affected.map(a => `- ${a.customer} | ${a.device} | Bộ ký: ${a.signingLabel || "Chưa đặt tên"} | UDID …${a.udidSuffix}`),
    "", "Kiểm tra mục Thiết bị trên trang quản trị và liên hệ nhà cung cấp để thay bộ ký khi cần.",
    "Cảnh báo không tự thay chứng chỉ, ký lại IPA, thu hồi key hoặc xóa app trên thiết bị."];
  return { subject: `[Nemo] ${payload.title.replace(/[\r\n]/g, " ").slice(0, 150)}`, text: lines.join("\n"), messageId: `<nemo-certificate-${id}@alerts.nemo.invalid>` };
}
function transportFor(config: NonNullable<ReturnType<typeof mailConfig>>) {
  return nodemailer.createTransport({ host: config.host, port: config.port, secure: config.port === 465,
    requireTLS: true, tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    auth: { user: config.user, pass: config.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
}
export async function verifyCertificateEmail() {
  const config = mailConfig(); if (!config) throw new Error("smtp_not_configured");
  const transport = transportFor(config);
  try { await transport.verify(); } finally { transport.close(); }
}
export async function sendCertificateEmail(id: string, payload: CertificateAlertPayload) {
  const config = mailConfig();
  if (!config) throw new Error("smtp_not_configured");
  const transport = transportFor(config);
  try {
    const result = await transport.sendMail({ from: config.from, to: config.to, ...alertMessage(id, payload) });
    if (!result.accepted?.length || result.rejected?.length) throw new Error("smtp_rejected");
  } finally { transport.close(); }
}
