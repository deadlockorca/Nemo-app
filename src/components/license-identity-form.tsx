"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { IdentityConfig } from "@/lib/identity-config";

export function LicenseIdentityForm({ licenseId, onSaved, onBusy }: {
  licenseId: string; onSaved: () => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [config, setConfig] = useState<{ identity: IdentityConfig | null; version: number; bound: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/licenses/${licenseId}/identity`, { cache: "no-store", signal: controller.signal });
        if (response.status === 401) { router.push("/"); return; }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setConfig(data);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Chưa tải được cấu hình."); }
    })();
    return () => controller.abort();
  }, [licenseId, router]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || busy) return;
    const values = new FormData(event.currentTarget);
    setBusy(true); onBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/licenses/${licenseId}/identity`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: config.version, confirmBoundDevice: values.get("confirm") === "on",
          identity: { v: 1, device_id: values.get("device_id"), uuid: values.get("uuid") } }),
      });
      if (response.status === 401) { router.push("/"); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Chưa lưu được cấu hình. Tải lại trước khi thử lại."); }
    finally { setBusy(false); onBusy(false); }
  }

  return <form className="management-form" onSubmit={save}>
    <p className="confirmation-copy">Cặp ID đã đăng ký hợp lệ sẽ được cấp cho app sau khi key được xác minh. Cấu hình này không đổi thời hạn hay liên kết thiết bị của key.</p>
    {error && <p className="error-box" role="alert">{error}</p>}
    {!config ? <p role="status">{error ? "Đóng hộp thoại rồi mở lại để tải cấu hình." : "Đang tải cấu hình…"}</p> : <>
      <label htmlFor="identity-device">Device ID</label>
      <input autoFocus id="identity-device" name="device_id" defaultValue={config.identity?.device_id ?? ""} required minLength={36} maxLength={36}
        pattern="[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}" autoComplete="off" spellCheck={false} disabled={busy} />
      <p className="field-help">36 ký tự viết hoa, gồm dấu gạch ngang. Không phải UDID Apple hoặc fingerprint license.</p>
      <label htmlFor="identity-registration">UUID đăng ký Nemo</label>
      <input id="identity-registration" name="uuid" defaultValue={config.identity?.uuid ?? ""} required minLength={64} maxLength={64}
        pattern="[A-Fa-f0-9]{64}" autoComplete="off" spellCheck={false} disabled={busy} />
      <p className="field-help">Đúng 64 ký tự hexadecimal được cấp qua đăng ký hợp lệ. Lưu nguyên giá trị, không tự tạo ID.</p>
      {config.bound && <label className="saved-checkbox"><input name="confirm" type="checkbox" required disabled={busy} />Tôi xác nhận key đã liên kết thiết bị; app sẽ nhận cấu hình này trong lần xác minh tiếp theo.</label>}
      <button type="submit" className="primary-button" disabled={busy}>{busy ? "Đang lưu…" : config.identity ? "Lưu cấu hình" : "Gán cấu hình"}</button>
    </>}
  </form>;
}
