"use client";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { actionTitles, formatDate, formatRemaining, sectionTitles, type ListData, type ManagementRow, type ManagementSection } from "@/lib/management-types";
import { LicenseLocationForm } from "./license-location-form";
import { LicenseIdentityForm } from "./license-identity-form";

type ModalState = { kind: "customer" | "delete-customer" | "key" | "extend" | "revoke" | "restore" | "delete" | "release" | "identity" | "location"; row?: ManagementRow } | null;
const statusTitles: Record<string, string> = { pending: "Chưa kích hoạt", active: "Đang dùng", expired: "Hết hạn", revoked: "Đã thu hồi" };
const descriptions: Record<ManagementSection, string> = {
  customers: "Lưu thông tin khách hàng để cấp và theo dõi giấy phép.",
  licenses: "Cấp key, theo dõi hạn dùng và gia hạn khi khách thanh toán.",
  devices: "Mỗi key gắn với một thiết bị. Gỡ liên kết khi cần chuyển máy.",
  activity: "Theo dõi người thực hiện, thời gian và các thay đổi trong hệ thống.",
};
function Dialog({ title, onClose, busy, children }: { title: string; onClose?: () => void; busy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="management-dialog" aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose?.(); }}>
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2>{onClose && <button type="button" className="icon-button" aria-label="Đóng" disabled={busy} onClick={onClose}>×</button>}</div>{children}
  </dialog>;
}

export function Management({ section, initial, embedded = false }: { section: ManagementSection; initial: ListData; embedded?: boolean }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState({ q: "", status: "" });
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<ModalState>(null);
  const [modalError, setModalError] = useState("");
  const [issuedKey, setIssuedKey] = useState("");
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerOptions, setCustomerOptions] = useState<ManagementRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [customerError, setCustomerError] = useState("");
  const [includeIdentity, setIncludeIdentity] = useState(false);
  const requestId = useRef(0);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (section !== "licenses") return;
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [section]);

  useEffect(() => {
    if (modal?.kind !== "key") return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/admin/customers?q=${encodeURIComponent(customerSearch)}`, { signal: controller.signal, cache: "no-store" });
        if (response.status === 401) { router.push("/"); return; }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setCustomerOptions(result.items);
        setCustomerError("");
      } catch (cause) {
        if (!controller.signal.aborted) setCustomerError(cause instanceof Error ? cause.message : "Chưa thể tải khách hàng.");
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [modal?.kind, customerSearch, router]);

  async function load(page = 1, filters = query) {
    const currentRequest = ++requestId.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ ...filters, page: String(page) });
      const response = await fetch(`/api/admin/${section}?${params}`, { cache: "no-store" });
      if (response.status === 401) { router.push("/"); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (currentRequest === requestId.current) setData(result);
    } catch (cause) {
      if (currentRequest === requestId.current) setError(cause instanceof Error ? cause.message : "Chưa thể tải danh sách.");
    } finally { if (currentRequest === requestId.current) setLoading(false); }
  }
  function open(kind: NonNullable<ModalState>["kind"], row?: ManagementRow) {
    setIncludeIdentity(false);
    setModalError(""); setNotice(""); setCustomerId(""); setCustomerSearch(""); setCustomerOptions([]); setCustomerError(""); setModal({ kind, row });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || busy) return;
    setBusy(true); setModalError("");
    const form = new FormData(event.currentTarget);
    let path = "";
    let method = "POST";
    let body: Record<string, unknown> = {};
    const row = modal.row;
    if (modal.kind === "customer") {
      path = "/customers" + (row ? `/${row.id}` : ""); method = row ? "PATCH" : "POST";
      body = { nemoUsername: form.get("nemo_username"), name: form.get("name"), contact: form.get("contact"), notes: form.get("notes"), version: row?.version };
    } else if (modal.kind === "delete-customer") {
      path = `/customers/${row!.id}`; method = "DELETE"; body = { version: row!.version };
    } else if (modal.kind === "key") {
      path = "/licenses"; body = { customerId, durationDays: Number(form.get("days")) };
      if (form.get("include_identity") === "on") body.identity = { v: 1, device_id: form.get("device_id"), uuid: form.get("uuid") };
    } else if (modal.kind === "release") {
      path = `/devices/${row!.id}/release`; body = { version: row!.version };
    } else {
      path = `/licenses/${row!.id}/${modal.kind}`; body = { version: row!.version, days: Number(form.get("days")) };
    }
    try {
      const response = await fetch(`/api/admin${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (response.status === 401) { router.push("/"); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (result.key) { setIssuedKey(result.key); setSaved(false); setCopied(false); }
      setModal(null);
      setNotice("Đã lưu thay đổi.");
      await load(data.page);
      router.refresh();
    } catch (cause) { setModalError(cause instanceof Error ? cause.message : "Mất kết nối. Hãy đóng hộp thoại và tải lại danh sách để kiểm tra trước khi thử lại."); }
    finally { setBusy(false); }
  }

  const isCustomer = section === "customers";
  const customerDeleteBlocked = modal?.kind === "delete-customer" && (Number(modal.row?.license_count) > 0 || Number(modal.row?.device_profile_count) > 0);
  return <>
    {!embedded && <section className="dashboard-intro page-intro"><div><span className="eyebrow text-muted">QUẢN LÝ HỆ THỐNG</span><h1>{sectionTitles[section]}</h1><p>{descriptions[section]}</p></div>
      {(isCustomer || section === "licenses") && <button type="button" className="primary-button" onClick={() => open(isCustomer ? "customer" : "key")}>+ {isCustomer ? "Thêm khách hàng" : "Cấp key mới"}</button>}
    </section>}
    {section === "licenses" && <p className="info-strip">Key bắt đầu tính hạn ngay khi cấp cho khách hàng. Nhập key trên app chỉ liên kết thiết bị, không đặt lại ngày hết hạn.</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p className="success-box" role="status">{notice}</p>}
    <section className="records-card" aria-busy={loading}>
      <form className="table-toolbar" onSubmit={(event) => { event.preventDefault(); const filters = { q, status }; setQuery(filters); void load(1, filters); }}>
        <label className="search-field"><span className="sr-only">Tìm kiếm</span><input name="search" value={q} onChange={(event) => setQ(event.target.value)} maxLength={120} placeholder={section === "activity" ? "Tìm hành động, người thực hiện, mã…" : "Tìm tên khách, mã key…"} /></label>
        {section === "licenses" && <label><span className="sr-only">Trạng thái</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tất cả trạng thái</option>{Object.entries(statusTitles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <button className="secondary-button" disabled={busy || loading} type="submit">Tìm kiếm</button>
        <button className="secondary-button" disabled={busy || loading} type="button" onClick={() => void load(data.page)}>Tải lại</button>
      </form>
      <div className="table-scroll"><table className="records-table"><thead><tr>
        {section === "customers" && <><th>Khách hàng</th><th>Liên hệ</th><th>Số key</th><th>Ghi chú</th><th>Thao tác</th></>}
        {section === "licenses" && <><th>Key / Khách hàng</th><th>Trạng thái</th><th>Thời hạn</th><th>Thời gian còn lại</th><th>Thao tác</th></>}
        {section === "devices" && <><th>Thiết bị</th><th>Khách hàng / Key</th><th>Liên kết lúc</th><th>Lần cuối kết nối</th><th>Thao tác</th></>}
        {section === "activity" && <><th>Hành động</th><th>Người thực hiện</th><th>Đối tượng</th><th>Thời gian</th><th>Chi tiết</th></>}
      </tr></thead><tbody>{data.items.map((row) => <tr key={row.id}>
        {section === "customers" && <><td><strong>{row.name}</strong><small>Khách #{row.id}</small><small>Nemo: {row.nemo_username || "Chưa gán tên đăng nhập"}</small></td><td>{row.contact || "—"}</td><td>{row.license_count}</td><td className="notes-cell">{row.notes || "—"}</td><td><div className="row-actions"><button className="text-button" type="button" onClick={() => open("customer", row)}>Chỉnh sửa</button><Link className="text-button" href={`/admin/devices?q=${encodeURIComponent(row.name || "")}`}>Thiết bị ({row.device_profile_count || 0})</Link><button className="text-button danger-text" type="button" onClick={() => open("delete-customer", row)}>Xóa</button></div></td></>}
        {section === "licenses" && <><td><code>•••• {row.key_hint}</code><small>{row.customer_name} · #{row.id}</small>{row.device_label && <small>{row.device_label} · {row.signing_label || "Chưa đặt tên bộ ký"} · …{row.apple_udid?.slice(-8)}</small>}<small className="identity-state">{Number(row.has_identity) ? "Đã gán hai ID" : "Chưa gán hai ID"}</small></td><td><span className={`badge badge-${row.display_status}`}>{statusTitles[row.display_status!]}</span></td><td>{row.display_status === "pending" ? `${row.duration_days} ngày từ kích hoạt` : row.activated_at ? `Từ ${formatDate(row.activated_at)}` : "Chưa kích hoạt"}</td><td className="license-countdown">{row.display_status === "revoked" ? <span title={row.expires_at ? `Hết hạn: ${formatDate(row.expires_at)}` : undefined}>Đã thu hồi</span> : row.expires_at ? <time dateTime={row.expires_at} title={`Hết hạn: ${formatDate(row.expires_at)}`}>{formatRemaining(row.expires_at, now)}</time> : "Chưa kích hoạt"}</td><td><div className="row-actions"><button className="text-button" type="button" disabled={row.display_status === "revoked"} onClick={() => open("identity", row)}>Cấu hình app</button><button className="text-button" type="button" onClick={() => open("location", row)}>Vị trí thử nghiệm</button><button className="text-button" type="button" disabled={row.display_status === "revoked"} onClick={() => open("extend", row)}>Gia hạn</button>{row.display_status === "revoked" ? <button className="text-button" type="button" onClick={() => open("restore", row)}>Khôi phục</button> : <button className="text-button danger-text" type="button" onClick={() => open("revoke", row)}>Thu hồi</button>}<button className="text-button danger-text" type="button" onClick={() => open("delete", row)}>Xóa</button></div></td></>}
        {section === "devices" && <><td><strong>{row.device_label || row.name || `Thiết bị #${row.id}`}</strong>{row.apple_udid && <small>UDID: …{row.apple_udid.slice(-8)} · {row.signing_label || "Chưa đặt tên bộ ký"}</small>}<small title={row.fingerprint}>Fingerprint app: {row.fingerprint?.slice(0, 12)}…</small></td><td>{row.customer_name}<small>•••• {row.key_hint}</small></td><td>{formatDate(row.bound_at)}</td><td>{formatDate(row.last_seen_at)}</td><td><button type="button" className="text-button danger-text" onClick={() => open("release", row)}>Gỡ liên kết</button></td></>}
        {section === "activity" && <><td><strong>{actionTitles[row.action!] || row.action}</strong></td><td>{row.display_name || "Hệ thống"}</td><td>{row.target_id ? `#${row.target_id}` : "—"}</td><td>{formatDate(row.created_at)}</td><td>{row.details ? <details><summary>Xem chi tiết</summary><pre className="audit-details">{JSON.stringify(row.details, null, 2)}</pre></details> : "—"}</td></>}
      </tr>)}</tbody></table></div>
      {!data.items.length && <div className="table-empty"><span aria-hidden="true">◇</span><h2>{query.q || query.status ? "Không tìm thấy kết quả" : "Chưa có dữ liệu"}</h2><p>{query.q || query.status ? "Thử đổi từ khóa hoặc bộ lọc." : isCustomer ? "Thêm khách hàng đầu tiên để bắt đầu cấp key." : section === "licenses" ? "Thêm khách hàng rồi cấp key mới tại đây." : section === "devices" ? "Thiết bị sẽ xuất hiện sau khi kích hoạt key qua API." : "Các thao tác quản trị sẽ được ghi lại tại đây."}</p></div>}
      <footer className="table-pagination"><span>{data.total} bản ghi · Trang {data.page}/{data.pages}</span><div><button type="button" className="secondary-button" disabled={data.page <= 1 || loading || busy} onClick={() => void load(data.page - 1)}>← Trước</button><button type="button" className="secondary-button" disabled={data.page >= data.pages || loading || busy} onClick={() => void load(data.page + 1)}>Sau →</button></div></footer>
    </section>
    {modal && <Dialog title={modal.kind === "customer" ? (modal.row ? "Chỉnh sửa khách hàng" : "Thêm khách hàng") : modal.kind === "delete-customer" ? "Xóa khách hàng" : modal.kind === "key" ? "Cấp key mới" : modal.kind === "location" ? `Vị trí thử nghiệm · ${modal.row?.customer_name}` : modal.kind === "identity" ? `Cấu hình app · ${modal.row?.customer_name}` : modal.kind === "extend" ? "Gia hạn key" : modal.kind === "revoke" ? "Thu hồi key" : modal.kind === "restore" ? "Khôi phục key" : modal.kind === "delete" ? "Xóa key" : "Gỡ liên kết thiết bị"} onClose={() => setModal(null)} busy={busy}>
      {modal.kind === "location" ? <LicenseLocationForm licenseId={modal.row!.id} onBusy={setBusy} onSaved={() => { setModal(null); load(); }} /> : modal.kind === "identity" ? <LicenseIdentityForm licenseId={modal.row!.id} onBusy={setBusy} onSaved={async () => {
        setModal(null); setNotice("Đã lưu cấu hình. App nhận hai ID trong lần kích hoạt hoặc xác minh tiếp theo."); await load(data.page); router.refresh();
      }} /> : <form className="management-form" onSubmit={submit}>
        {modalError && <p className="error-box" role="alert">{modalError}</p>}
        {modal.kind === "customer" && <><label htmlFor="customer-name">Tên khách hàng</label><input autoFocus id="customer-name" name="name" defaultValue={modal.row?.name} required maxLength={120} placeholder="Ví dụ: Nguyễn Minh Anh" /><label htmlFor="customer-nemo-username">Mã nhân viên / Tên đăng nhập Nemo</label><input id="customer-nemo-username" name="nemo_username" defaultValue={modal.row?.nemo_username || ""} maxLength={120} autoComplete="off" spellCheck={false} /><p className="field-help">Để trống nếu chưa dùng vị trí thử nghiệm. Không nhập mật khẩu.</p><label htmlFor="customer-contact">Thông tin liên hệ</label><input id="customer-contact" name="contact" defaultValue={modal.row?.contact || ""} maxLength={254} placeholder="Số điện thoại hoặc email (tùy chọn)" /><label htmlFor="customer-notes">Ghi chú</label><textarea id="customer-notes" name="notes" rows={3} defaultValue={modal.row?.notes || ""} maxLength={2000} /></>}
        {modal.kind === "key" && <><label htmlFor="customer-search">Tìm khách hàng</label><input autoFocus id="customer-search" value={customerSearch} onChange={(event) => { setCustomerSearch(event.target.value); setCustomerId(""); }} maxLength={120} placeholder="Nhập tên hoặc thông tin liên hệ" /><label htmlFor="customer-choice">Khách hàng nhận key</label><select id="customer-choice" value={customerId} onChange={(event) => setCustomerId(event.target.value)} required><option value="">Chọn khách hàng…</option>{customerOptions.map((row) => <option key={row.id} value={row.id}>{row.name} · #{row.id}</option>)}</select>{customerError && <p role="alert" className="danger-text">{customerError}</p>}<p className="field-help">Hiện tối đa 25 kết quả. Nhập tên để tìm thêm. <Link href="/admin/customers">Thêm khách hàng</Link></p></>}
        {(modal.kind === "key" || modal.kind === "extend") && <><label htmlFor="license-days">{modal.kind === "key" ? "Thời hạn sử dụng (ngày)" : "Số ngày thêm"}</label><input id="license-days" name="days" type="number" min={1} max={365} step={1} defaultValue={30} required /><p className="field-help">{modal.kind === "key" ? "Thời hạn bắt đầu ngay khi tạo key. Khách nhập key sau vẫn giữ nguyên ngày hết hạn." : modal.row?.display_status === "pending" ? "Key cũ chưa kích hoạt sẽ cộng vào thời lượng, chưa bắt đầu đếm ngày." : "Key còn hạn: cộng vào hạn hiện tại. Key đã hết hạn: tính từ thời điểm gia hạn."}</p></>}
        {modal.kind === "key" && <><label className="saved-checkbox"><input type="checkbox" name="include_identity" checked={includeIdentity} onChange={event => setIncludeIdentity(event.target.checked)} />Gán hai ID cho IPA trắng</label>{includeIdentity && <><label htmlFor="new-device-id">Device ID</label><input id="new-device-id" name="device_id" required minLength={36} maxLength={36} pattern="[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}" autoComplete="off" spellCheck={false} /><label htmlFor="new-registration-uuid">UUID đăng ký Nemo</label><input id="new-registration-uuid" name="uuid" required minLength={64} maxLength={64} pattern="[A-Fa-f0-9]{64}" autoComplete="off" spellCheck={false} /><p className="field-help">Nhập cặp ID đã đăng ký hợp lệ. Có thể gán sau bằng nút Cấu hình app.</p></>}</>}
        {modal.kind === "delete-customer" && <><p className="confirmation-copy">Xóa vĩnh viễn khách hàng <strong>{modal.row?.name} · #{modal.row?.id}</strong>? Lịch sử thao tác vẫn được giữ lại.</p>{customerDeleteBlocked && <p className="error-box" role="alert">Khách còn {modal.row?.license_count || 0} key và {modal.row?.device_profile_count || 0} hồ sơ thiết bị. Xóa key trong <Link href="/admin/licenses">Quản lý key</Link>, rồi xóa hồ sơ trong <Link href={`/admin/devices?q=${encodeURIComponent(modal.row?.name || "")}`}>Thiết bị</Link> trước. Sau đó tải lại danh sách khách hàng.</p>}</>}
        {modal.kind === "delete" && <p className="confirmation-copy">Xóa vĩnh viễn key <strong>•••• {modal.row?.key_hint}</strong> của <strong>{modal.row?.customer_name}</strong>? Key sẽ ngừng cấp phép, bị xóa khỏi danh sách và gỡ liên kết thiết bị. Không thể khôi phục key sau khi xóa; lịch sử thao tác vẫn được giữ lại.</p>}
        {modal.kind === "restore" && <p className="confirmation-copy">Khôi phục key <strong>•••• {modal.row?.key_hint}</strong> của <strong>{modal.row?.customer_name}</strong>? Giữ nguyên thời hạn và liên kết thiết bị hiện có. Nếu key đã hết hạn, cần gia hạn thêm để sử dụng.</p>}
        {modal.kind === "revoke" && <p className="confirmation-copy">Thu hồi key <strong>•••• {modal.row?.key_hint}</strong> của <strong>{modal.row?.customer_name}</strong>? Key sẽ bị khóa cho đến khi được khôi phục. Thời hạn và liên kết thiết bị được giữ nguyên.</p>}
        {modal.kind === "release" && <p className="confirmation-copy">Gỡ liên kết <strong>{modal.row?.name || `thiết bị #${modal.row?.id}`}</strong> của <strong>{modal.row?.customer_name}</strong>? Key sẽ có thể gắn với máy mới khi kích hoạt, ngày hết hạn giữ nguyên.</p>}
        <div className="dialog-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => setModal(null)}>Hủy</button><button type="submit" className={`primary-button ${["revoke", "delete", "delete-customer", "release"].includes(modal.kind) ? "danger-button" : ""}`} disabled={busy || customerDeleteBlocked || (modal.kind === "key" && !customerId)}>{busy ? "Đang lưu…" : modal.kind === "revoke" ? "Xác nhận thu hồi" : modal.kind === "restore" ? "Xác nhận khôi phục" : (modal.kind === "delete" || modal.kind === "delete-customer") ? "Xóa vĩnh viễn" : modal.kind === "release" ? "Gỡ liên kết" : modal.kind === "key" ? "Tạo key" : "Lưu thay đổi"}</button></div>
      </form>}
    </Dialog>}
    {issuedKey && <Dialog title="Đã cấp key thành công" busy={false}>
      <p className="confirmation-copy">Key chỉ hiển thị đầy đủ lần này. Sao chép và gửi cho đúng khách hàng trước khi đóng.</p><label htmlFor="issued-key" className="sr-only">Key vừa tạo</label><input id="issued-key" className="issued-key" readOnly value={issuedKey} onFocus={(event) => event.target.select()} />
      <button type="button" className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(issuedKey); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Đã sao chép" : "Sao chép key"}</button>
      <label className="saved-checkbox"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} />Tôi đã lưu key để giao cho khách hàng</label><button type="button" className="primary-button" disabled={!saved} onClick={() => setIssuedKey("")}>Hoàn tất</button>
    </Dialog>}
  </>;
}
