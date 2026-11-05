import { createHash, randomBytes } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import type { Admin } from "./auth";
import { InputError } from "./validation";
import { inspectIpaSource, objectPath, removeObject, storeObject } from "./install-storage";

const publicFields = "r.id, r.label, r.notes, r.source_sha256, r.size_bytes, r.metadata, r.state, r.version, r.created_at";
export function ipaReleaseId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw new InputError("Phiên bản IPA không hợp lệ.");
  return value;
}
export async function activeIpaReleases() {
  const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT ${publicFields} FROM ios_ipa_releases r WHERE r.state = 'active' ORDER BY r.created_at DESC, r.id DESC`);
  return rows;
}
export async function listIpaReleases(params: URLSearchParams) {
  const q = (params.get("q") || "").trim().slice(0, 120), state = params.get("state");
  let where = "1 = 1";
  const values: string[] = [];
  if (q) {
    where += " AND (r.label LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(r.metadata, '$.version')) LIKE ? OR r.source_sha256 = ?)";
    values.push(`%${q}%`, `%${q}%`, q);
  }
  if (state === "active" || state === "archived") { where += " AND r.state = ?"; values.push(state); }
  const [count] = await getDb().execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ios_ipa_releases r WHERE ${where}`, values);
  const total = Number(count[0].n), pages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(pages, Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1));
  const [items] = await getDb().execute<RowDataPacket[]>(`SELECT ${publicFields}, (SELECT COUNT(*) FROM ios_installations i WHERE i.release_id = r.id) AS installation_count
    FROM ios_ipa_releases r WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`, values);
  return { items, total, page, pages };
}
export async function sourceRelease(value: unknown) {
  const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT * FROM ios_ipa_releases WHERE id = ? AND state = 'active'`, [ipaReleaseId(value)]);
  if (!rows.length) throw new InputError("Phiên bản IPA không còn được chọn cho bản cài mới. Hãy tải lại thư viện.", 409);
  return rows[0];
}
async function discardUnusedSource(key: string) {
  // In an ambiguous database failure, retaining an orphan is safer than
  // removing a source that a committed release/installation might reference.
  try {
    const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT EXISTS(SELECT 1 FROM ios_ipa_releases WHERE source_key = ?) OR EXISTS(SELECT 1 FROM ios_installations WHERE source_key = ?) AS used`, [key, key]);
    if (!Number(rows[0].used)) await removeObject(key, "ipa");
  } catch { console.error("IPA source cleanup deferred."); }
}
export async function uploadIpaRelease(admin: Admin, form: FormData) {
  const label = form.get("label"), notes = form.get("notes") || "", file = form.get("ipa");
  if (typeof label !== "string" || !label.trim() || label.trim().length > 120 || label.includes("\0")) throw new InputError("Tên phiên bản cần 1–120 ký tự.");
  if (typeof notes !== "string" || notes.trim().length > 2000 || notes.includes("\0")) throw new InputError("Ghi chú cần tối đa 2.000 ký tự.");
  if (!(file instanceof File) || !file.size || file.size > 150 * 1024 * 1024) throw new InputError("Chọn IPA trắng có dung lượng tối đa 150 MB.");
  const bytes = Buffer.from(await file.arrayBuffer()), digest = createHash("sha256").update(bytes).digest("hex");
  const existing = async () => (await getDb().execute<RowDataPacket[]>(`SELECT id, label, state FROM ios_ipa_releases WHERE source_sha256 = ?`, [digest]))[0][0];
  const found = await existing();
  if (found) return { ...found, duplicate: true };
  const source = await storeObject(bytes, "ipa");
  try {
    const metadata = await inspectIpaSource(objectPath(source, "ipa"));
    if (metadata.sourceSha256 !== digest) throw new InputError("IPA nguồn đã thay đổi trong lúc kiểm tra.", 409);
    const id = randomBytes(16).toString("hex"), db = await getDb().getConnection();
    try {
      await db.beginTransaction();
      await db.execute(`INSERT INTO ios_ipa_releases (id, label, notes, source_key, source_sha256, size_bytes, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, label.trim(), notes.trim() || null, source, digest, bytes.length, JSON.stringify(metadata)]);
      await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'ipa_release.created', ?, ?)`, [admin.id, id, JSON.stringify({ label: label.trim(), sha256: digest, version: metadata.version, build: metadata.build })]);
      await db.commit();
    } catch (e) { await db.rollback(); throw e; }
    finally { db.release(); }
    return { id, label: label.trim(), state: "active", duplicate: false };
  } catch (e) {
    await discardUnusedSource(source);
    if ((e as { code?: string }).code === "ER_DUP_ENTRY") {
      const duplicate = await existing();
      if (duplicate) return { ...duplicate, duplicate: true };
    }
    throw e;
  }
}
export async function changeIpaRelease(admin: Admin, value: unknown, action: string, data: Record<string, unknown>) {
  const id = ipaReleaseId(value);
  if (!["archive", "restore"].includes(action)) throw new InputError("Không tìm thấy thao tác.", 404);
  if (typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1) throw new InputError("Thiếu phiên bản bản ghi. Hãy tải lại thư viện.");
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT state, version FROM ios_ipa_releases WHERE id = ? FOR UPDATE`, [id]);
    if (!rows.length) throw new InputError("Không tìm thấy phiên bản IPA.", 404);
    if (rows[0].version !== data.version) throw new InputError("Phiên bản đã thay đổi. Hãy tải lại thư viện.", 409);
    const state = action === "archive" ? "archived" : "active";
    if (rows[0].state === state) throw new InputError("Trạng thái đã thay đổi. Hãy tải lại thư viện.", 409);
    await db.execute(`UPDATE ios_ipa_releases SET state = ?, version = version + 1 WHERE id = ?`, [state, id]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id) VALUES (?, ?, ?)`, [admin.id, action === "archive" ? "ipa_release.archived" : "ipa_release.restored", id]);
    await db.commit(); return { id };
  } catch (e) { await db.rollback(); throw e; }
  finally { db.release(); }
}
