"use client";

import { useEffect, useState, type FormEvent } from "react";
import { mergeLocationCenters, type LocationCenter } from "@/lib/location-contract";

type Policy = { employeeUsername: string | null; enabled: boolean; centers: LocationCenter[]; version: number;
  catalog: { label: string; missingCoordinates: number; centers: (LocationCenter & { name: string })[] } | null };
export function LicenseLocationForm({ licenseId, onBusy, onSaved }: { licenseId: string; onBusy: (busy: boolean) => void; onSaved: () => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [centers, setCenters] = useState<LocationCenter[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/licenses/${licenseId}/location`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Không tải được cấu hình.");
        setPolicy(data); setEnabled(data.enabled);
        if (data.version === 0 && data.catalog?.centers.length) {
          setCenters(data.catalog.centers);
          setNotice(`Đã điền sẵn ${data.catalog.centers.length} địa điểm. Bấm Lưu cấu hình vị trí để áp dụng cho key này.`);
        } else setCenters(data.centers);
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [licenseId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!policy || busy) return;
    setBusy(true); onBusy(true); setError("");
    try {
      const response = await fetch(`/api/admin/licenses/${licenseId}/location`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: policy.version, enabled, centers }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Không lưu được cấu hình.");
      onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); onBusy(false); }
  }
  function update(index: number, field: keyof LocationCenter, value: string) {
    setCenters(rows => rows.map((row, i) => i === index ? { ...row, [field]: field === "hospitalId" ? value : (value === "" ? Number.NaN : Number(value)) } : row));
  }
  function importCatalog() {
    if (!policy?.catalog) return;
    try {
      const merged = mergeLocationCenters(centers, policy.catalog.centers);
      setCenters(merged); setError("");
      setNotice(`Đã thêm ${merged.length - centers.length} địa điểm còn thiếu, giữ nguyên các điểm đã có. Bấm Lưu cấu hình vị trí để áp dụng.`);
    } catch (error) { setError((error as Error).message); }
  }
  return <form className="management-form" onSubmit={submit}>
    {error && <p className="error-box" role="alert">{error}</p>}
    {!policy ? <p role="status">{error ? "Đóng hộp thoại rồi mở lại để tải cấu hình." : "Đang tải cấu hình…"}</p> : <>
      <p>Tên đăng nhập Nemo: <strong>{policy.employeeUsername || "Chưa gán"}</strong></p>
      {!policy.employeeUsername && <p className="field-help">Gán tên đăng nhập trong phần Chỉnh sửa khách hàng trước khi bật.</p>}
      <label className="saved-checkbox"><input type="checkbox" checked={enabled} disabled={busy || !policy.employeeUsername} onChange={event => setEnabled(event.target.checked)} />Cho phép random vị trí trên key này</label>
      <p className="field-help">Chỉ có hiệu lực với bản app hỗ trợ và key này. Các key khác cần được bật riêng.</p>
      {policy.catalog && <>
        <button type="button" className="secondary-button" disabled={busy} onClick={importCatalog}>Thêm {policy.catalog.centers.length} địa điểm từ danh mục</button>
        <p className="field-help">{policy.catalog.label}. {policy.catalog.missingCoordinates} địa điểm thiếu tọa độ chưa được đưa vào danh mục.</p>
      </>}
      {notice && <p className="info-strip" role="status">{notice}</p>}
      {centers.map((center, index) => <fieldset key={index} disabled={busy}>
        <legend>{policy.catalog?.centers.find(row => row.hospitalId === center.hospitalId)?.name || `Địa điểm ${index + 1}`}</legend>
        <label htmlFor={`hospital-${index}`}>ID địa điểm trong app</label>
        <input id={`hospital-${index}`} value={center.hospitalId} required maxLength={20} pattern="[0-9]+" onChange={event => update(index, "hospitalId", event.target.value)} />
        <label htmlFor={`lat-${index}`}>Vĩ độ tâm</label>
        <input id={`lat-${index}`} type="number" required min={-90} max={90} step="any" value={Number.isFinite(center.latitude) ? center.latitude : ""} onChange={event => update(index, "latitude", event.target.value)} />
        <label htmlFor={`lon-${index}`}>Kinh độ tâm</label>
        <input id={`lon-${index}`} type="number" required min={-180} max={180} step="any" value={Number.isFinite(center.longitude) ? center.longitude : ""} onChange={event => update(index, "longitude", event.target.value)} />
        <label htmlFor={`radius-${index}`}>Bán kính (m)</label>
        <input id={`radius-${index}`} type="number" required min={1} max={120} step="any" value={Number.isFinite(center.radiusMeters) ? center.radiusMeters : ""} onChange={event => update(index, "radiusMeters", event.target.value)} />
        <button type="button" className="text-button danger-text" onClick={() => setCenters(rows => rows.filter((_, i) => i !== index))}>Xóa địa điểm</button>
      </fieldset>)}
      <button type="button" className="secondary-button" disabled={busy || centers.length >= 100} onClick={() => setCenters(rows => [...rows, { hospitalId: "", latitude: Number.NaN, longitude: Number.NaN, radiusMeters: 120 }])}>Thêm địa điểm</button>
      <p className="field-help">Dùng ID đã đối chiếu trong lượt Bắt đầu/Kết thúc, không dùng mã hiển thị thay thế.</p>
      <div className="dialog-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "Đang lưu…" : "Lưu cấu hình vị trí"}</button></div>
    </>}
  </form>;
}
