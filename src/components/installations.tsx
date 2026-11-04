"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatDate } from "@/lib/management-types";
import { signingError, type InstallationItem } from "@/lib/installation-types";
import { ProfileUpload } from "./profile-upload";
import type { ProfileInspection } from "@/lib/device-profile-types";

type Data = { items: InstallationItem[]; licenses: { id: string; key_hint: string; customer_name: string }[] };
const states: Record<string, string> = { queued: "Đang xếp hàng", signing: "Đang ký", ready: "Sẵn sàng", failed: "Cần thử lại" };
export function Installations({ initial }: { initial: Data }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<{ code: string; title: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [inspection, setInspection] = useState<ProfileInspection | null>(null);
  const [appleUdid, setAppleUdid] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const reload = useCallback(async () => {
    const r = await fetch("/api/admin/installations", { cache: "no-store" });
    if (r.status === 401) { router.push("/"); return; }
    const result = await r.json();
    if (!r.ok) throw new Error(result.error);
    setData(result);
  }, [router]);
  useEffect(() => {
    if (!data.items.some((i) => (i.state === "active" && !Number(i.code_expired)) || i.job_status === "queued" || i.job_status === "signing")) return;
    const timer = setInterval(() => { if (!document.hidden) void reload().catch(() => setError("Chưa cập nhật được trạng thái. Hãy tải lại danh sách.")); }, 5000);
    return () => clearInterval(timer);
  }, [data.items, reload]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || inspecting) return;
    const form = event.currentTarget;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/admin/installations", { method: "POST", body: new FormData(form) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      setIssued({ code: result.code, title: "Mã cài mới", expiresAt: result.expiresAt }); setCopied(false);
      form.reset(); setInspection(null); setAppleUdid(""); setShowForm(false); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Chưa thể tải lên bản cài."); }
    finally { setBusy(false); }
  }
  async function action(item: InstallationItem, operation: "rotate" | "revoke") {
    if (busy) return;
    const message = operation === "revoke" ? `Thu hồi quyền tải bản cài “${item.label}”? App đã cài và key kích hoạt giữ nguyên.` : `Cấp mã mới cho “${item.label}”? Mã mới có hiệu lực 15 phút; mã và phiên tải cũ sẽ hết hiệu lực.`;
    if (!window.confirm(message)) return;
    setBusy(true); setError("");
    try {
      const r = await fetch(`/api/admin/installations/${item.id}/${operation}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      if (result.code) { setIssued({ code: result.code, title: "Mã cài thay thế", expiresAt: result.expiresAt }); setCopied(false); }
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Chưa xử lý được thao tác."); }
    finally { setBusy(false); }
  }
  return <>
    <section className="dashboard-intro"><p>PHÂN PHỐI ỨNG DỤNG</p><h1>Cài đặt Nemo</h1><p>Chuẩn bị bản cài theo chứng chỉ của khách. Hai ID được cấp riêng khi kích hoạt bằng key.</p></section>
    <div className="install-toolbar"><Link href="/install" className="secondary-button" target="_blank" rel="noreferrer">Mở trang khách ↗</Link><button className="secondary-button" disabled={busy} onClick={() => void reload().catch(() => setError("Chưa tải được danh sách."))}>Cập nhật</button><button className="primary-button" disabled={busy} onClick={() => setShowForm(!showForm)}>{showForm ? "Đóng biểu mẫu" : "+ Tạo bản cài"}</button></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {issued && <section className="install-code-card" aria-live="polite"><div><span className="eyebrow">{issued.title}</span><h2>Lưu mã này để gửi cho khách</h2><p>Khách vào <strong>/install</strong> rồi nhập mã dưới đây. Mã chỉ hiển thị một lần, có hiệu lực 15 phút kể từ lúc cấp.</p><p>Hết hạn: <strong>{formatDate(issued.expiresAt)}</strong>. Hết hạn tải không làm thay đổi key kích hoạt.</p></div><code>{issued.code}</code><div className="install-toolbar"><button className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(issued.code); setCopied(true); } catch { setError("Không sao chép được. Hãy chọn và sao chép mã bằng tay."); } }}>{copied ? "Đã sao chép" : "Sao chép mã"}</button><button className="secondary-button" onClick={() => setIssued(null)}>Tôi đã lưu mã</button></div></section>}
    {showForm && <section className="activity-card install-create"><div className="section-heading"><div><span className="eyebrow">BẢN CÀI MỚI</span><h2>Chọn key và bộ chứng chỉ</h2></div></div>
      {!data.licenses.length ? <p className="empty-state">Chưa có key phù hợp. <Link href="/admin/licenses"><u>Tạo key và gán hai ID</u></Link> trước khi tạo bản cài.</p> : <form className="management-form" onSubmit={create}>
        <label>Key của khách<select name="licenseId" required disabled={busy}><option value="">Chọn key đã gán hai ID</option>{data.licenses.map((l) => <option key={l.id} value={l.id}>{l.customer_name} · …{l.key_hint}</option>)}</select></label>
        <label>Tên bản cài<input name="label" maxLength={120} placeholder="Ví dụ: iPad của khách An" required disabled={busy} /></label>
        <label>Mã bộ chứng chỉ<input name="signingLabel" maxLength={120} placeholder="Ví dụ: HNF6HG" disabled={busy} /><small>Tên dễ nhớ sẽ được lưu cùng hồ sơ thiết bị.</small></label>
        <ProfileUpload required disabled={busy} onBusy={setInspecting} onRead={info => { setInspection(info); setAppleUdid(info.udids.length === 1 ? info.udids[0] : ""); }} />
        <label>UDID Apple của máy{inspection && inspection.udids.length > 1 ? <select name="appleUdid" required value={appleUdid} onChange={e => setAppleUdid(e.target.value)} disabled={busy || inspecting}><option value="">Chọn đúng UDID máy khách</option>{inspection.udids.map(u => <option key={u} value={u}>{u}</option>)}</select> : <input name="appleUdid" value={appleUdid} onChange={e => setAppleUdid(e.target.value.toUpperCase())} spellCheck={false} autoCapitalize="characters" placeholder="Chọn profile để tự đọc UDID" required disabled={busy || inspecting} />}<small>{inspection ? `${inspection.udids.length} UDID trong profile ${inspection.profileName}` : "Khác device_id 36 ký tự của Nemo."}</small></label>
        <label>IPA trắng<input name="ipa" type="file" accept=".ipa" required disabled={busy} /><small>IPA trắng NemoBlankIdentity-1, tối đa 150 MB.</small></label>
        <label>Chứng chỉ .p12<input name="p12" type="file" accept=".p12,.pfx" required disabled={busy} /></label>
        <label>Mật khẩu .p12<input name="password" type="password" maxLength={512} autoComplete="off" disabled={busy} /></label>
        <p className="field-help">Sau khi kiểm tra bộ tệp thành công, hồ sơ thiết bị sẽ tự lưu UDID và hạn bộ ký. Mã cài có hiệu lực 15 phút kể từ lúc cấp. Key và hai ID Nemo giữ nguyên.</p>
        <button className="primary-button" disabled={busy || inspecting}>{busy ? "Đang tải và kiểm tra bộ tệp…" : "Kiểm tra và tạo mã cài"}</button>
      </form>}
    </section>}
    <section className="activity-card install-list"><div className="section-heading"><div><span className="eyebrow">CÁC BẢN CÀI</span><h2>{data.items.length} bản gần nhất</h2></div></div>
      {!data.items.length ? <p className="empty-state">Chưa có bản cài. Tạo bản đầu tiên để khách có thể chuẩn bị và tải Nemo.</p> : <div className="table-scroll"><table className="records-table"><thead><tr><th>Bản cài</th><th>Khách & key</th><th>Chứng chỉ</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{data.items.map((i) => <tr key={i.id}>
        <td><strong>{i.label}</strong><small>Nemo {i.metadata.version} · …{i.apple_udid.slice(-8)}</small><small>{formatDate(i.created_at)}</small><small>Mã cài hết hạn: {formatDate(i.code_expires_at)}</small></td>
        <td>{i.customer_name}<small>…{i.key_hint}</small></td>
        <td><span>Team {i.metadata.team}</span><small>Hết hạn {formatDate(i.metadata.profileExpiresAt)}</small><small>{i.metadata.profileDeviceCount} máy trong profile · {i.metadata.signingMode === "development" ? "Development" : "Ad Hoc"}</small></td>
        <td><span className="status-pill">{i.state === "revoked" ? "Đã thu hồi" : Number(i.code_expired) ? "Mã cài hết hạn" : states[i.job_status || ""] || "Chờ khách chuẩn bị"}</span>{i.job_status === "failed" && <small className="install-error-detail">{signingError(i.error_code)}</small>}</td>
        <td><div className="row-actions"><button className="secondary-button" disabled={busy || i.state !== "active"} onClick={() => void action(i, "rotate")}>Cấp mã mới</button><button className="secondary-button danger-button" disabled={busy || i.state !== "active"} onClick={() => void action(i, "revoke")}>Thu hồi</button></div></td>
      </tr>)}</tbody></table></div>}
    </section>
  </>;
}
