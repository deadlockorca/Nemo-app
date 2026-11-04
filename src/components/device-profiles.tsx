"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { DeviceProfile, DeviceProfileList, ProfileInspection } from "@/lib/device-profile-types";
import { formatDate, type ListData, type ManagementRow } from "@/lib/management-types";
import { Management } from "./management";
import { ProfileUpload } from "./profile-upload";

const keyStatuses: Record<string, string> = { active: "Đang dùng", revoked: "Đã thu hồi", expired: "Hết hạn", pending: "Chưa kích hoạt" };
const day = (s?: string | null) => s ? s.slice(0, 10) : "";
const toIso = (s: string, previous?: string | null) => !s ? null : s === day(previous) ? new Date(previous!).toISOString() : `${s}T00:00:00.000Z`;
type Draft = { customerId: string; licenseId: string; label: string; model: string; appleUdid: string; signingLabel: string; certificateExpiresAt: string; profileExpiresAt: string; notes: string };
const draftOf = (row?: DeviceProfile | null): Draft => ({ customerId: row?.customer_id || "", licenseId: row?.license_id || "", label: row?.label || "", model: row?.model || "", appleUdid: row?.apple_udid || "", signingLabel: row?.signing_label || "", certificateExpiresAt: day(row?.certificate_expires_at), profileExpiresAt: day(row?.profile_expires_at), notes: row?.notes || "" });

export function DeviceProfiles({ initial, bindings, initialQuery = "" }: { initial: DeviceProfileList; bindings: ListData; initialQuery?: string }) {
  const router = useRouter();
  const [data, setData] = useState(initial), [tab, setTab] = useState("profiles");
  const [q, setQ] = useState(initialQuery), [appliedQuery, setAppliedQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ row: DeviceProfile | null } | null>(null);
  const [detail, setDetail] = useState<DeviceProfile | null>(null), [draft, setDraft] = useState<Draft>(draftOf());
  const [customers, setCustomers] = useState<ManagementRow[]>([]), [licenses, setLicenses] = useState<ManagementRow[]>([]);
  const [customerSearch, setCustomerSearch] = useState(""), [inspection, setInspection] = useState<ProfileInspection | null>(null);
  const [deleting, setDeleting] = useState<DeviceProfile | null>(null);
  const dialog = useRef<HTMLDialogElement>(null), requestId = useRef(0);
  const activeDialog = !!editor || !!detail || !!deleting;
  useEffect(() => { const d = dialog.current; if (activeDialog) d?.showModal(); return () => d?.close(); }, [activeDialog]);
  useEffect(() => {
    if (!editor) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/customers?q=${encodeURIComponent(customerSearch)}`, { signal: controller.signal, cache: "no-store" });
        const result = await r.json(); if (!r.ok) throw new Error(result.error); setCustomers(result.items);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Chưa tải được khách hàng."); }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [editor, customerSearch]);
  useEffect(() => {
    if (!editor || !draft.customerId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/admin/licenses?customerId=${draft.customerId}`, { signal: controller.signal, cache: "no-store" });
        const result = await r.json(); if (!r.ok) throw new Error(result.error); setLicenses(result.items);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Chưa tải được key."); }
    })();
    return () => controller.abort();
  }, [editor, draft.customerId]);
  function edit(row: DeviceProfile | null) {
    setLicenses([]); setDeleting(null); setDetail(null); setDraft(draftOf(row)); setInspection(null); setCustomerSearch(""); setError(""); setEditor({ row });
  }
  async function load(page = 1, query = appliedQuery) {
    const current = ++requestId.current; setLoading(true); setError("");
    try {
      const r = await fetch(`/api/admin/device-profiles?${new URLSearchParams({ q: query, page: String(page) })}`, { cache: "no-store" });
      if (r.status === 401) { router.push("/"); return; }
      const result = await r.json(); if (!r.ok) throw new Error(result.error);
      if (current === requestId.current) setData(result);
    } catch (e) { if (current === requestId.current) setError(e instanceof Error ? e.message : "Chưa tải được hồ sơ."); }
    finally { if (current === requestId.current) setLoading(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!editor || busy || inspecting) return;
    setBusy(true); setError("");
    try {
      const row = editor.row;
      const r = await fetch(`/api/admin/device-profiles${row ? `/${row.id}` : ""}`, {
        method: row ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, version: row?.version,
          certificateExpiresAt: toIso(draft.certificateExpiresAt, inspection?.certificateExpiresAt || row?.certificate_expires_at),
          profileExpiresAt: toIso(draft.profileExpiresAt, inspection?.profileExpiresAt || row?.profile_expires_at) }),
      });
      const result = await r.json(); if (!r.ok) throw new Error(result.error);
      setEditor(null); setNotice("Đã lưu hồ sơ thiết bị."); await load(data.page); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Chưa lưu được hồ sơ."); }
    finally { setBusy(false); }
  }
  function confirmDelete(row: DeviceProfile) {
    setEditor(null); setDetail(null); setError(""); setDeleting(row);
  }
  async function remove(event: FormEvent) {
    event.preventDefault(); if (!deleting || busy) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/admin/device-profiles/${deleting.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: deleting.version }) });
      const result = await r.json(); if (!r.ok) throw new Error(result.error);
      setDeleting(null); setNotice("Đã xóa hồ sơ thiết bị."); await load(data.page); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Chưa xóa được hồ sơ."); }
    finally { setBusy(false); }
  }
  const set = (key: keyof Draft, value: string) => setDraft(d => ({ ...d, [key]: value }));
  const close = () => { if (!busy && !inspecting) { setEditor(null); setDetail(null); setDeleting(null); setError(""); } };
  const customerOptions = editor?.row && !customers.some(c => c.id === editor.row!.customer_id)
    ? [{ id: editor.row.customer_id, name: editor.row.customer_name }, ...customers] : customers;
  return <>
    <section className="dashboard-intro page-intro"><div><span className="eyebrow text-muted">QUẢN LÝ HỆ THỐNG</span><h1>Thiết bị</h1><p>Tìm máy theo tên khách, UDID Apple hoặc mã bộ chứng chỉ.</p></div><button className="primary-button" onClick={() => { setTab("profiles"); edit(null); }}>+ Thêm hồ sơ thiết bị</button></section>
    <div className="device-tabs" aria-label="Danh sách thiết bị"><button className={tab === "profiles" ? "selected" : ""} aria-pressed={tab === "profiles"} onClick={() => setTab("profiles")}>Hồ sơ thiết bị</button><button className={tab === "bindings" ? "selected" : ""} aria-pressed={tab === "bindings"} onClick={() => setTab("bindings")}>Đã kích hoạt key</button></div>
    {tab === "bindings" ? <Management section="devices" initial={bindings} embedded /> : <>
      <p className="info-strip">Có thể lưu hồ sơ trước khi khách cài app. Fingerprint xuất hiện sau khi khách kích hoạt key đã gắn với hồ sơ.</p>
      {notice && <p className="success-box" role="status">{notice}</p>}{error && !activeDialog && <p className="error-box" role="alert">{error}</p>}
      <section className="records-card" aria-busy={loading}><form className="table-toolbar" onSubmit={e => { e.preventDefault(); setAppliedQuery(q); void load(1, q); }}><label className="search-field"><span className="sr-only">Tìm hồ sơ thiết bị</span><input value={q} onChange={e => setQ(e.target.value)} maxLength={120} placeholder="Tên khách, tên máy, UDID, mã chứng chỉ…" /></label><button className="secondary-button" disabled={loading}>Tìm kiếm</button><button type="button" className="secondary-button" disabled={loading} onClick={() => void load(data.page)}>Tải lại</button></form>
        <div className="table-scroll"><table className="records-table"><thead><tr><th>Thiết bị / UDID</th><th>Khách hàng / Key</th><th>Bộ chứng chỉ</th><th>Hạn key</th><th>Kích hoạt</th><th>Thao tác</th></tr></thead><tbody>{data.items.map(row => <tr key={row.id}>
          <td><strong>{row.label}</strong><small>{row.model || "Chưa ghi model"} · …{row.apple_udid.slice(-8)}</small></td>
          <td>{row.customer_name}<small>Khách #{row.customer_id}{row.license_id ? ` · Key #${row.license_id} · …${row.key_hint}` : " · Chưa gắn key"}</small></td>
          <td><strong>{row.signing_label || "Chưa đặt tên bộ ký"}</strong><small>Chứng chỉ: {row.certificate_expires_at ? formatDate(row.certificate_expires_at) : "Chưa có hạn"}</small><small>Profile: {row.profile_expires_at ? formatDate(row.profile_expires_at) : "Chưa có hạn"}</small></td>
          <td>{row.key_expires_at ? formatDate(row.key_expires_at) : "—"}<small>{row.key_status ? keyStatuses[row.key_status] : "Chưa gắn key"}</small></td>
          <td><span className={`status-pill ${row.fingerprint ? "active" : "pending"}`}>{row.fingerprint ? "Đã kích hoạt" : "Chưa kích hoạt"}</span><small>{row.last_seen_at ? `Kết nối: ${formatDate(row.last_seen_at)}` : ""}</small></td>
          <td><div className="row-actions"><button className="text-button" onClick={() => { setError(""); setDetail(row); }}>Chi tiết</button><button className="text-button danger-text" onClick={() => confirmDelete(row)}>Xóa</button></div></td>
        </tr>)}</tbody></table></div>
        {!data.items.length && <div className="table-empty"><h2>{appliedQuery ? "Không tìm thấy thiết bị" : "Chưa có hồ sơ thiết bị"}</h2><p>Thêm tên máy và UDID, hoặc tạo bản cài để tự ghi nhận bộ chứng chỉ.</p></div>}
        <footer className="table-pagination"><span>{data.total} hồ sơ · Trang {data.page}/{data.pages}</span><div><button className="secondary-button" disabled={loading || data.page <= 1} onClick={() => void load(data.page - 1)}>← Trước</button><button className="secondary-button" disabled={loading || data.page >= data.pages} onClick={() => void load(data.page + 1)}>Sau →</button></div></footer>
      </section>
    </>}
    {activeDialog && <dialog ref={dialog} className="management-dialog device-dialog" aria-labelledby="device-dialog-title" onCancel={e => { e.preventDefault(); close(); }}>
      <div className="dialog-heading"><h2 id="device-dialog-title">{deleting ? "Xóa hồ sơ thiết bị" : editor ? editor.row ? "Sửa hồ sơ thiết bị" : "Thêm hồ sơ thiết bị" : detail!.label}</h2><button className="icon-button" aria-label="Đóng" disabled={busy || inspecting} onClick={close}>×</button></div>
      {error && <p className="error-box" role="alert">{error}</p>}
      {deleting && <form className="management-form" onSubmit={remove}><p className="confirmation-copy">Xóa vĩnh viễn hồ sơ <strong>{deleting.label}</strong> của <strong>{deleting.customer_name}</strong>?</p><p className="field-help">UDID Apple: <code>{deleting.apple_udid}</code>. Xóa hồ sơ không gỡ app hoặc xóa dữ liệu Keychain trên iPad. Lịch sử thao tác vẫn được giữ lại.</p>{(deleting.license_id || deleting.installation_id) && <p className="error-box" role="alert">Hồ sơ còn gắn key {deleting.license_id ? `#${deleting.license_id}` : ""} hoặc bản cài. <Link href="/admin/licenses">Xóa key liên quan</Link> trước; nếu chưa có bản cài, có thể bỏ gắn key trong Chỉnh sửa. Sau đó tải lại danh sách thiết bị.</p>}<div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={close}>Hủy</button><button className="primary-button danger-button" disabled={busy || !!deleting.license_id || !!deleting.installation_id}>{busy ? "Đang xóa…" : "Xóa vĩnh viễn"}</button></div></form>}
      {detail && <><dl className="device-details"><dt>Khách hàng</dt><dd>{detail.customer_name} · #{detail.customer_id}</dd><dt>Model</dt><dd>{detail.model || "Chưa ghi"}</dd><dt>UDID Apple</dt><dd><code>{detail.apple_udid}</code></dd><dt>Bộ chứng chỉ</dt><dd>{detail.signing_label || "Chưa ghi"}</dd><dt>Hết hạn chứng chỉ</dt><dd>{formatDate(detail.certificate_expires_at)}</dd><dt>Hết hạn profile</dt><dd>{formatDate(detail.profile_expires_at)}</dd><dt>Key</dt><dd>{detail.license_id ? `#${detail.license_id} · …${detail.key_hint}` : "Chưa gắn"}</dd><dt>Hết hạn key</dt><dd>{formatDate(detail.key_expires_at)}</dd><dt>Fingerprint app</dt><dd><code>{detail.fingerprint || "Chưa kích hoạt key"}</code></dd><dt>Ghi chú</dt><dd>{detail.notes || "—"}</dd></dl>
        <div className="dialog-actions"><button className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(detail.apple_udid); setNotice("Đã sao chép UDID Apple."); } catch { setError("Chọn UDID ở trên để sao chép bằng tay."); } }}>Sao chép UDID</button><button className="primary-button" onClick={() => edit(detail)}>Chỉnh sửa</button></div></>}
      {editor && <form className="management-form" onSubmit={save}><fieldset disabled={busy || inspecting} className="device-fieldset">
        {!editor.row && <label>Tìm khách hàng<input value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} placeholder="Tên hoặc thông tin liên hệ" maxLength={120} /></label>}
        <label>Khách hàng<select value={draft.customerId} required disabled={!!editor.row} onChange={e => { setLicenses([]); setDraft(d => ({ ...d, customerId: e.target.value, licenseId: "" })); }}><option value="">Chọn khách hàng</option>{customerOptions.map(c => <option key={c.id} value={c.id}>{c.name} · #{c.id}</option>)}</select></label>
        <label>Tên dễ nhớ<input value={draft.label} onChange={e => set("label", e.target.value)} maxLength={120} required placeholder="Ví dụ: iPad Hải" /></label>
        <label>Model<input value={draft.model} onChange={e => set("model", e.target.value)} maxLength={80} placeholder="Ví dụ: iPad15,8" /></label>
        <ProfileUpload disabled={busy} onBusy={setInspecting} onRead={info => {
          if (editor.row?.installation_id && !info.udids.includes(editor.row.apple_udid)) { setError("Profile này không chứa UDID của hồ sơ đã gắn bản cài."); return; }
          setError(""); setInspection(info); setDraft(d => ({ ...d,
            appleUdid: editor.row?.installation_id ? editor.row.apple_udid : info.udids.length === 1 ? info.udids[0] : info.udids.includes(d.appleUdid) ? d.appleUdid : "",
            profileExpiresAt: day(info.profileExpiresAt), certificateExpiresAt: day(info.certificateExpiresAt) }));
        }} />
        {inspection && <p className="field-help">{inspection.profileName} · Team {inspection.team} · {inspection.udids.length} thiết bị. Thông tin chỉ được lưu khi bấm Lưu hồ sơ.</p>}
        <label>UDID Apple{inspection && inspection.udids.length > 1 ? <select required value={draft.appleUdid} disabled={!!editor.row?.installation_id} onChange={e => set("appleUdid", e.target.value)}><option value="">Chọn đúng UDID máy khách</option>{inspection.udids.map(u => <option key={u} value={u}>{u}</option>)}</select> : <input value={draft.appleUdid} onChange={e => set("appleUdid", e.target.value.toUpperCase())} maxLength={40} required spellCheck={false} readOnly={!!editor.row?.installation_id} placeholder="00008120-001A30480C080032" />}</label>
        <label>Mã bộ chứng chỉ<input value={draft.signingLabel} onChange={e => set("signingLabel", e.target.value)} maxLength={120} placeholder="Ví dụ: HNF6HG" /></label>
        <div className="device-date-fields"><label>Ngày hết hạn chứng chỉ<input type="date" value={draft.certificateExpiresAt} onChange={e => set("certificateExpiresAt", e.target.value)} /></label><label>Ngày hết hạn profile<input type="date" value={draft.profileExpiresAt} onChange={e => set("profileExpiresAt", e.target.value)} /></label></div>
        <label>Key của khách<select value={draft.licenseId} disabled={!draft.customerId || !!editor.row?.installation_id} onChange={e => set("licenseId", e.target.value)}><option value="">Chưa gắn key</option>{editor.row?.license_id && !licenses.some(l => l.id === editor.row!.license_id) && <option value={editor.row.license_id}>Key #{editor.row.license_id} · …{editor.row.key_hint}</option>}{licenses.map(l => <option key={l.id} value={l.id}>Key #{l.id} · …{l.key_hint}</option>)}</select></label>
        <p className="field-help">Gắn key để đối chiếu máy. Hồ sơ này không thay đổi thời hạn, hai ID Nemo hoặc liên kết kích hoạt của key.</p>
        <label>Ghi chú<textarea rows={3} value={draft.notes} onChange={e => set("notes", e.target.value)} maxLength={2000} /></label>
      </fieldset><div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy || inspecting} onClick={close}>Hủy</button><button className="primary-button" disabled={busy || inspecting}>{busy ? "Đang lưu…" : "Lưu hồ sơ"}</button></div></form>}
    </dialog>}
    <p className="field-help device-install-link">Quản lý tệp .p12, IPA và mã cài tại <Link href="/admin/installations">Cài đặt Nemo ↗</Link>.</p>
  </>;
}
