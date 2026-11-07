import { spawn } from "node:child_process";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import type { Admin } from "./auth";
import { getDb } from "./db";
import { InputError, id } from "./validation";
import { removeObject, storeObject } from "./install-storage";

export type MonitoredProfile = { profileName: string; profileExpiresAt: string; certificates: { sha256: string; expiresAt: string }[] };
async function inspectCertificateProfile(profile: string, udid: string): Promise<MonitoredProfile> {
  return new Promise((resolve, reject) => {
    const child = spawn(/* turbopackIgnore: true */ process.env.IOS_SIGN_PYTHON || "python3", [path.join(process.cwd(), "scripts/ios/certificate_status.py")], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "", invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill("SIGKILL"); }, 30000);
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 8192) { invalid = true; child.kill("SIGKILL"); } });
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(new InputError("Công cụ kiểm tra profile chưa sẵn sàng.", 503)); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || invalid || !Array.isArray(result.certificates) || !result.certificates.length || result.certificates.length > 16 || !Number.isFinite(Date.parse(result.profileExpiresAt)) ||
          result.certificates.some((c: {sha256?:string; expiresAt?:string}) => !/^[a-f0-9]{64}$/.test(c.sha256 || "") || !Number.isFinite(Date.parse(c.expiresAt || "")))) throw new Error();
        resolve(result);
      } catch { reject(new InputError("Profile cần có chữ ký Apple hợp lệ, đúng UDID của hồ sơ và chứng chỉ được hỗ trợ.")); }
    });
    child.stdin.end(JSON.stringify({ mode: "inspect-profile", profile, udid }));
  });
}
export async function attachMonitorProfile(admin: Admin, profileId: string, form: FormData, inspectOnly = false) {
  id(profileId);
  const file = form.get("profile"), version = Number(form.get("version"));
  if (!(file instanceof File) || !file.size || file.size > 2 * 1024 * 1024) throw new InputError("Chọn .mobileprovision có dung lượng tối đa 2 MB.");
  if (!inspectOnly && (!Number.isInteger(version) || version < 1)) throw new InputError("Hãy tải lại hồ sơ trước khi gắn profile.");
  const [profiles] = await getDb().execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE id = ?`, [profileId]);
  if (!profiles.length) throw new InputError("Không tìm thấy hồ sơ.", 404);
  const profile = Buffer.from(await file.arrayBuffer()).toString("base64");
  const metadata = await inspectCertificateProfile(profile, profiles[0].apple_udid);
  if (inspectOnly) return metadata;
  const sha = form.get("certificateSha256");
  const selected = sha ? metadata.certificates.find(c => c.sha256 === sha) : metadata.certificates.length === 1 ? metadata.certificates[0] : null;
  if (!selected) throw new InputError("Chọn đúng chứng chỉ trong profile để theo dõi.");
  // This encrypted object deliberately contains no P12 or signing private key.
  const stored = await storeObject(Buffer.from(JSON.stringify({ profile, p12: "", password: "" })), "secret");
  const db = await getDb().getConnection();
  let previous: string | null = null;
  try {
    await db.beginTransaction();
    const [current] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE id = ? FOR UPDATE`, [profileId]);
    if (!current.length || current[0].version !== version || current[0].apple_udid !== profiles[0].apple_udid || current[0].installation_id !== profiles[0].installation_id) throw new InputError("Hồ sơ vừa thay đổi. Hãy tải lại và thử lại.", 409);
    const [before] = await db.execute<RowDataPacket[]>(`SELECT secrets_key FROM ios_device_certificate_assets WHERE device_profile_id = ?`, [profileId]);
    previous = before[0]?.secrets_key || null;
    const payload = { certificateSha256: selected.sha256, certificateExpiresAt: selected.expiresAt, profileExpiresAt: metadata.profileExpiresAt };
    await db.execute(`INSERT INTO ios_device_certificate_assets (device_profile_id, bound_installation_id, secrets_key, certificate_sha256, metadata) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE bound_installation_id = VALUES(bound_installation_id), secrets_key = VALUES(secrets_key), certificate_sha256 = VALUES(certificate_sha256), metadata = VALUES(metadata), created_at = UTC_TIMESTAMP(3)`,
      [profileId, current[0].installation_id, stored, selected.sha256, JSON.stringify(payload)]);
    await db.execute(`UPDATE customer_device_profiles SET certificate_expires_at = ?, profile_expires_at = ?, version = version + 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`, [new Date(selected.expiresAt), new Date(metadata.profileExpiresAt), profileId]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'device_profile.monitor_attached', ?, ?)`, [admin.id, profileId, JSON.stringify({ certificateSha256: selected.sha256 })]);
    await db.commit();
  } catch (e) {
    await db.rollback();
    // A connection failure during COMMIT can be ambiguous. Never remove an
    // object that the committed asset row references.
    try {
      const [used] = await getDb().execute<RowDataPacket[]>(`SELECT 1 FROM ios_device_certificate_assets WHERE secrets_key = ?`, [stored]);
      if (!used.length) await removeObject(stored, "secret");
    } catch { /* keep an orphan rather than delete committed assets */ }
    throw e;
  } finally { db.release(); }
  if (previous) await removeObject(previous, "secret").catch(() => { /* deferred orphan cleanup */ });
  return { ok: true };
}
