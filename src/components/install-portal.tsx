"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CustomerInstall } from "@/lib/installation-types";

type InstallLink = { installUrl: string; https: boolean };
const statusText: Record<string, string> = { new: "Bản cài dành cho bạn", queued: "Đã nhận yêu cầu", signing: "Đang chuẩn bị Nemo", ready: "Nemo đã sẵn sàng", failed: "Cần chuẩn bị lại bản cài" };
export function InstallPortal() {
  const [current, setCurrent] = useState<CustomerInstall | null>(null);
  const [link, setLink] = useState<InstallLink | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const showError = useCallback((cause: unknown) => {
    const e = cause as Error & { status?: number };
    if (e.status === 401) { setCurrent(null); setLink(null); }
    setError(e.message || "Chưa thể xử lý. Hãy thử lại.");
  }, []);
  const request = useCallback(async (action: string, data?: unknown) => {
    const r = await fetch(`/api/install/${action}`, data === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const body = await r.json();
    if (!r.ok) throw Object.assign(new Error(body.error || "Chưa thể xử lý. Hãy thử lại."), { status: r.status });
    return body;
  }, []);
  useEffect(() => {
    let live = true;
    void request("status").then((r) => { if (live) setCurrent(r); }).catch((e) => { if (live && e.status !== 401) setError(e.message); }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [request]);
  useEffect(() => {
    if (current?.status !== "queued" && current?.status !== "signing") return;
    const timer = setInterval(() => { if (!document.hidden) void request("status").then(setCurrent).catch(showError); }, 3000);
    return () => clearInterval(timer);
  }, [current?.status, request, showError]);
  const loadLink = useCallback(async () => {
    try { setLink(await request("link", {})); setError(""); }
    catch (e) { showError(e); }
  }, [request, showError]);
  useEffect(() => {
    if (current?.status !== "ready") return;
    let live = true;
    void request("link", {}).then((result) => { if (live) { setLink(result); setError(""); } }).catch((e) => { if (live) showError(e); });
    const timer = setInterval(() => { if (!document.hidden) void loadLink(); }, 25 * 60 * 1000);
    return () => { live = false; clearInterval(timer); };
  }, [current?.status, loadLink, request, showError]);
  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try { await request("login", { code }); setCode(""); setCurrent(await request("status")); }
    catch (e) { setError(e instanceof Error ? e.message : "Chưa kiểm tra được mã cài."); }
    finally { setBusy(false); }
  }
  async function prepare() {
    if (busy) return; setBusy(true); setError("");
    try { await request("prepare", {}); setCurrent(await request("status")); }
    catch (e) { showError(e); }
    finally { setBusy(false); }
  }
  return <main className="install-shell"><header className="install-brand"><span className="brand-icon">n.</span><strong>nemo</strong><span>CÀI ĐẶT ỨNG DỤNG</span></header>
    <section className="install-portal-card"><div className="install-app-icon" aria-hidden="true">nemo<span>●</span></div>
      <p className="eyebrow">NEMO CHO IPHONE & IPAD</p><h1>{current ? statusText[current.status] || "Cài đặt Nemo" : "Nemo, sẵn sàng trên máy bạn."}</h1>
      {checking ? <p className="install-description" role="status">Đang kiểm tra phiên cài đặt…</p> : current ? <>
        <p className="install-description">{current.label}<br />Phiên bản {current.version} · Máy có UDID kết thúc bằng <strong>{current.deviceSuffix}</strong></p>
        <ol className="install-steps"><li className="step-done"><span>1</span>Mã cài hợp lệ</li><li className={current.status === "ready" ? "step-done" : ""}><span>2</span>Chuẩn bị bản cài</li><li><span>3</span>Cài Nemo & nhập key</li></ol>
        {(current.status === "queued" || current.status === "signing") && <div className="install-progress" role="status"><span className="install-spinner" />{current.status === "queued" ? "Bản cài đang xếp hàng. Bạn có thể giữ trang này mở." : "Đang ký bản cài cho máy của bạn. Vui lòng chờ một chút."}</div>}
        {current.error && <div className="error-box" role="alert">{current.error}</div>}
        {(current.status === "new" || current.status === "failed") && <button className="primary-button install-main-button" disabled={busy} onClick={() => void prepare()}>{busy ? "Đang gửi yêu cầu…" : current.status === "failed" ? "Thử chuẩn bị lại" : "Chuẩn bị bản cài"}<span aria-hidden="true">→</span></button>}
        {current.status === "ready" && <>
          {link?.https ? <a className="primary-button install-main-button" href={link.installUrl}>Cài Nemo<span aria-hidden="true">↓</span></a> : <button className="primary-button install-main-button" disabled>{link ? "Bản cài đã sẵn sàng" : "Đang lấy liên kết cài…"}</button>}
          {link && !link.https && <p className="install-hint">Đây là địa chỉ thử local. Cài qua Safari cần trang HTTPS với chứng chỉ được iPad tin cậy.</p>}
          {!link && <button className="install-text-button" onClick={() => void loadLink()}>Lấy lại liên kết cài</button>}
          <p className="install-hint">Mở trang này bằng Safari trên iPhone/iPad. Sau khi bấm cài, xác nhận yêu cầu của iOS, rồi mở Nemo và nhập key được cấp.</p>
          {current.development && <p className="install-hint">Bộ chứng chỉ Development có thể yêu cầu bật Chế độ nhà phát triển trên máy.</p>}
        </>}
        <button className="install-text-button" disabled={busy} onClick={async () => { try { await request("logout", {}); setCurrent(null); setLink(null); setError(""); } catch (e) { setError((e as Error).message); } }}>Dùng mã cài khác</button>
      </> : <><p className="install-description">Nhập mã cài bạn được cấp để nhận bản Nemo dành cho thiết bị của mình.</p><form className="login-form" onSubmit={login}><label htmlFor="install-code">Mã cài đặt</label><input id="install-code" name="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={100} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" required disabled={busy} /><button className="primary-button" disabled={busy}>{busy ? "Đang kiểm tra…" : "Tiếp tục"}<span aria-hidden="true">→</span></button></form><p className="install-hint">Mã cài dùng để tải app. Key kích hoạt sẽ được nhập trong Nemo sau khi cài.</p></>}
      {error && <div className="error-box" role="alert">{error}</div>}
    </section><footer className="install-footer">Cần hỗ trợ? Liên hệ người đã cấp mã cài cho bạn.</footer>
  </main>;
}
