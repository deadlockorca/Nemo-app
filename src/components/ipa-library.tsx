"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { formatDate } from "@/lib/management-types";
import type { IpaRelease, IpaReleaseList } from "@/lib/ipa-release-types";

export function IpaLibrary({ initial }: { initial: IpaReleaseList }) {
  const router = useRouter();
  const [data, setData] = useState(initial), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [q, setQ] = useState(""), [state, setState] = useState("");
  const [showForm, setShowForm] = useState(false);
  async function reload(page = data.page) {
    const r = await fetch(`/api/admin/ipa-releases?${new URLSearchParams({ q, state, page: String(page) })}`, { cache: "no-store" });
    if (r.status === 401) { router.push("/"); throw new Error("Hãy đăng nhập lại."); }
    const result = await r.json();
    if (!r.ok) throw new Error(result.error);
    setData(result);
  }
  async function load(page = 1) {
    if (busy) return;
    setBusy(true); setError("");
    try { await reload(page); } catch (e) { setError(e instanceof Error ? e.message : "Chưa tải được thư viện."); }
    finally { setBusy(false); }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await fetch("/api/admin/ipa-releases", { method: "POST", body: new FormData(form) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      setMessage(result.duplicate ? `File này đã có trong thư viện: ${result.label}.${result.state === "archived" ? " Khôi phục phiên bản đó nếu muốn dùng cho bản cài mới." : " Có thể chọn lại khi tạo bản cài."}` : `Đã lưu ${result.label}. Chọn phiên bản này khi tạo bản cài cho khách.`);
      form.reset(); setShowForm(false); await reload(1);
    } catch (e) { setError(e instanceof Error ? e.message : "Chưa tải lên được IPA."); }
    finally { setBusy(false); }
  }
  async function change(item: IpaRelease) {
    if (busy) return;
    const action = item.state === "active" ? "archive" : "restore";
    if (!window.confirm(action === "archive" ? `Lưu trữ “${item.label}”? Phiên bản này sẽ không được chọn cho bản cài mới. Các bản cài đã tạo vẫn dùng được.` : `Khôi phục “${item.label}” để tạo bản cài mới?`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const r = await fetch(`/api/admin/ipa-releases/${item.id}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: item.version }) });
      const result = await r.json(); if (!r.ok) throw new Error(result.error);
      setMessage(action === "archive" ? "Đã lưu trữ phiên bản. Các bản cài hiện có giữ nguyên." : "Đã khôi phục phiên bản.");
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Chưa cập nhật được phiên bản."); }
    finally { setBusy(false); }
  }
  return <>
    <section className="dashboard-intro"><p>THƯ VIỆN ỨNG DỤNG</p><h1>IPA trắng</h1><p>Tải mỗi phiên bản lên một lần, dùng chung khi ký bản cài cho nhiều khách.</p></section>
    <div className="install-toolbar"><Link className="secondary-button" href="/admin/installations">Tạo bản cài cho khách ↗</Link><button className="primary-button" disabled={busy} onClick={() => setShowForm(!showForm)}>{showForm ? "Đóng biểu mẫu" : "+ Thêm phiên bản"}</button></div>
    {error && <div className="error-box" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    {showForm && <section className="activity-card install-create"><div className="section-heading"><h2>Thêm IPA trắng</h2></div><form className="management-form" onSubmit={upload}>
      <label>Tên phiên bản<input name="label" required maxLength={120} placeholder="Ví dụ: Nemo 6.11.23 — bản trắng v1" disabled={busy} /></label>
      <label>Tệp IPA trắng<input name="ipa" type="file" accept=".ipa" required disabled={busy} /><small>Tối đa 150 MB. Hệ thống kiểm tra tên Nemo, bundle và dấu nhận diện IPA trắng.</small></label>
      <label>Ghi chú<textarea name="notes" maxLength={2000} rows={3} placeholder="Nội dung thay đổi của phiên bản" disabled={busy} /></label>
      <p className="field-help">Không cần chứng chỉ ở bước này. Bộ chứng chỉ của từng máy được chọn khi tạo bản cài cho khách. File trùng nội dung sẽ được dùng lại.</p>
      <button className="primary-button" disabled={busy}>{busy ? "Đang tải và kiểm tra IPA…" : "Lưu phiên bản"}</button>
    </form></section>}
    <section className="activity-card install-list"><div className="section-heading"><h2>{data.total} phiên bản</h2></div>
      <form className="install-toolbar ipa-library-filter" onSubmit={e => { e.preventDefault(); void load(); }}><label>Tìm phiên bản<input value={q} onChange={e => setQ(e.target.value)} placeholder="Tên, phiên bản hoặc SHA-256" maxLength={120} disabled={busy} /></label><label>Trạng thái<select value={state} onChange={e => setState(e.target.value)} disabled={busy}><option value="">Tất cả</option><option value="active">Đang dùng</option><option value="archived">Đã lưu trữ</option></select></label><button className="secondary-button" disabled={busy}>Tìm / Cập nhật</button></form>
      {!data.items.length ? <p className="empty-state">Chưa có phiên bản phù hợp. Thêm IPA trắng để bắt đầu.</p> : <div className="table-scroll"><table className="records-table"><thead><tr><th>Phiên bản</th><th>Tệp nguồn</th><th>Bản cài</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}>
        <td><strong>{item.label}</strong><small>Nemo {item.metadata.version} ({item.metadata.build})</small>{item.notes && <small>{item.notes}</small>}<small>{formatDate(item.created_at)}</small></td>
        <td><span>{(Number(item.size_bytes) / 1024 / 1024).toFixed(1)} MB</span><small>SHA-256: <code title={item.source_sha256}>{item.source_sha256.slice(0, 12)}…{item.source_sha256.slice(-8)}</code></small></td>
        <td>{item.installation_count || "0"}</td><td><span className="status-pill">{item.state === "active" ? "Đang dùng" : "Đã lưu trữ"}</span></td>
        <td><button className="secondary-button" disabled={busy} onClick={() => void change(item)}>{item.state === "active" ? "Lưu trữ" : "Khôi phục"}</button></td>
      </tr>)}</tbody></table></div>}
      <div className="install-toolbar"><button className="secondary-button" disabled={busy || data.page <= 1} onClick={() => void load(data.page - 1)}>Trang trước</button><span>Trang {data.page} / {data.pages}</span><button className="secondary-button" disabled={busy || data.page >= data.pages} onClick={() => void load(data.page + 1)}>Trang sau</button></div>
    </section>
  </>;
}
