"use client";
import { useRef, useState } from "react";
import type { ProfileInspection } from "@/lib/device-profile-types";

export function ProfileUpload({ required = false, disabled = false, onRead, onBusy }: {
  required?: boolean; disabled?: boolean; onRead: (info: ProfileInspection) => void; onBusy: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  return <div className="profile-upload"><label>Hồ sơ cấp phép .mobileprovision
    <input name="profile" type="file" accept=".mobileprovision" required={required} disabled={disabled || reading} onChange={async event => {
      const file = event.target.files?.[0], current = ++sequence.current;
      setError(""); if (!file) return;
      if (file.size > 2 * 1024 * 1024) { setError("Profile cần tối đa 2 MB."); event.target.value = ""; return; }
      setReading(true); onBusy(true);
      try {
        const form = new FormData(); form.set("profile", file);
        const response = await fetch("/api/admin/device-profiles/inspect", { method: "POST", body: form });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (current === sequence.current) onRead(result);
      } catch (e) { if (current === sequence.current) setError(e instanceof Error ? e.message : "Chưa đọc được profile."); }
      finally { if (current === sequence.current) { setReading(false); onBusy(false); } }
    }} />
  </label><p className="field-help" role="status">{reading ? "Đang xác minh profile và đọc danh sách UDID…" : "Đọc UDID và ngày hết hạn từ profile có chữ ký Apple hợp lệ."}</p>
    {error && <p className="error-box" role="alert">{error}</p>}
  </div>;
}
