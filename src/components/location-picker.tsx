"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { LocationOption } from "@/lib/location-catalog";
import { generateNearbyCoordinate, LOCATION_LIMIT_METERS, normalizeLocationSearch, type GeneratedCoordinate } from "@/lib/location-random";
import styles from "./location-picker.module.css";

export function LocationPicker({ locations }: { locations: LocationOption[] }) {
  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState("");
  const [result, setResult] = useState<GeneratedCoordinate | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const revision = useRef(0);
  const coordinateInput = useRef<HTMLInputElement>(null);
  const selected = locations.find(location => location.code === selectedCode);
  const search = normalizeLocationSearch(query);
  const filtered = locations.filter(location => normalizeLocationSearch(`${location.name} ${location.sourceCodes.join(" ")}`).includes(search));
  const coordinateText = result ? `${result.latitude.toFixed(7)}, ${result.longitude.toFixed(7)}` : "";

  function choose(code: string) {
    if (code === selectedCode) return;
    revision.current++;
    setSelectedCode(code); setResult(null); setFeedback(""); setError("");
  }

  function generate() {
    if (!selected) return;
    revision.current++;
    setFeedback(""); setError("");
    try {
      let next = generateNearbyCoordinate(selected);
      for (let attempt = 0; result && next.latitude === result.latitude && next.longitude === result.longitude && attempt < 5; attempt++) {
        next = generateNearbyCoordinate(selected);
      }
      if (result && next.latitude === result.latitude && next.longitude === result.longitude) throw new Error("Vui lòng bấm tạo lại tọa độ.");
      setResult(next);
    } catch (cause) {
      setResult(null);
      setError(cause instanceof Error ? cause.message : "Chưa tạo được tọa độ. Vui lòng thử lại.");
    }
  }

  async function copy(value: string, label: string) {
    const currentRevision = revision.current;
    try {
      await navigator.clipboard.writeText(value);
      if (revision.current === currentRevision) setFeedback(`Đã sao chép ${label}.`);
    } catch {
      if (revision.current !== currentRevision) return;
      coordinateInput.current?.focus();
      coordinateInput.current?.select();
      setFeedback("Trình duyệt chưa cho phép sao chép. Hãy nhấn giữ ô tọa độ và chọn Sao chép.");
    }
  }

  const angle = (result?.bearingDegrees ?? 0) * Math.PI / 180;
  const offset = (result?.distanceMeters ?? 0) / LOCATION_LIMIT_METERS * 88;
  const dotX = 120 + Math.sin(angle) * offset, dotY = 114 - Math.cos(angle) * offset;

  return <main className={styles.shell}>
    <header className={styles.header}>
      <Link href="/locations" className="brand" aria-label="Nemo vị trí"><span className="brand-icon">n.</span> nemo<span className="brand-label">VỊ TRÍ</span></Link>
      <Link href="/install" className={styles.installLink}>Cài đặt Nemo <span aria-hidden="true">↗</span></Link>
    </header>
    <div className={styles.intro}>
      <span className="eyebrow">CHỌN ĐIỂM · TẠO TỌA ĐỘ · SAO CHÉP</span>
      <h1>Một điểm đến.<br /><span>Thêm một tọa độ gần bên.</span></h1>
      <p>Chọn địa điểm trong danh sách, rồi tạo tọa độ ngẫu nhiên cách điểm gốc dưới 150 mét.</p>
    </div>

    <div className={styles.workspace}>
      <section className={styles.catalog} aria-labelledby="location-list-title">
        <div className={styles.catalogHead}>
          <div className={styles.sectionTitle}><h2 id="location-list-title">Chọn địa điểm</h2><span>{locations.length} điểm</span></div>
          <label className={styles.searchLabel} htmlFor="location-search">Tìm theo tên hoặc mã địa điểm</label>
          <input id="location-search" className={styles.search} type="search" placeholder="Tên hoặc mã địa điểm…" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
          <p className={styles.searchCount} role="status">{filtered.length} địa điểm{search ? " phù hợp" : " có tọa độ"}</p>
        </div>
        <div className={styles.list}>
          {filtered.length ? filtered.map(location => <button key={location.code} type="button" className={`${styles.location} ${selectedCode === location.code ? styles.selected : ""}`} aria-pressed={selectedCode === location.code} onClick={() => choose(location.code)}>
            <span className={styles.locationMark} aria-hidden="true">{selectedCode === location.code ? "✓" : "◦"}</span>
            <span><strong>{location.name}</strong><small>{location.sourceCodes.join(" · ")}</small></span>
          </button>) : <div className={styles.noResults}><strong>Chưa tìm thấy địa điểm</strong><p>Thử tên ngắn hơn hoặc tìm bằng mã.</p><button type="button" onClick={() => setQuery("")}>Xóa tìm kiếm</button></div>}
        </div>
      </section>

      <section className={styles.generator} aria-labelledby="generator-title">
        <div className={styles.selectedHeader}>
          <span className="eyebrow">{selected ? "ĐỊA ĐIỂM ĐANG CHỌN" : "BẮT ĐẦU TỪ MỘT ĐỊA ĐIỂM"}</span>
          <h2 id="generator-title">{selected?.name ?? "Bạn muốn tạo tọa độ ở đâu?"}</h2>
          {selected ? <p className={styles.origin}>Tọa độ gốc <span>{selected.latitude.toFixed(7)}, {selected.longitude.toFixed(7)}</span></p> : <p className={styles.placeholder}>Chọn một điểm trong danh sách để bắt đầu.</p>}
        </div>
        <div className={styles.preview}>
          <svg viewBox="0 0 240 240" className={styles.diagram} role="img" aria-label={result ? `Sơ đồ khoảng cách: tọa độ mới cách điểm gốc ${result.distanceMeters.toFixed(1)} mét` : "Sơ đồ phạm vi 150 mét quanh điểm gốc"}>
            <circle cx="120" cy="114" r="88" fill="#eef4e8" stroke="#c4d5b7" strokeDasharray="4 5" />
            <circle cx="120" cy="114" r="44" fill="none" stroke="#dce7d5" />
            <path d="M32 114h176M120 26v176" stroke="#dce7d5" />
            {result && <line x1="120" y1="114" x2={dotX} y2={dotY} stroke="#23564b" strokeWidth="2" strokeDasharray="3 4" />}
            <circle cx="120" cy="114" r="5" fill="#7a8c78" />
            {result && <><circle cx={dotX} cy={dotY} r="12" fill="#23564b" opacity=".12" /><circle cx={dotX} cy={dotY} r="6" fill="#23564b" stroke="white" strokeWidth="2" /></>}
            <text x="120" y="226" textAnchor="middle" fill="#6a7773" fontSize="11">Sơ đồ phạm vi · 150 m</text>
          </svg>
          <div className={styles.distance}>
            <span>KHOẢNG CÁCH ĐẾN ĐIỂM GỐC</span>
            <strong>{result ? result.distanceMeters.toFixed(1) : "—"}<small>m</small></strong>
            <p>{result ? "Trong phạm vi dưới 150 m" : "Hiển thị sau khi tạo tọa độ"}</p>
          </div>
        </div>

        <button type="button" className={`primary-button ${styles.generate}`} onClick={generate} disabled={!selected}>{result ? "Tạo tọa độ khác" : "Tạo tọa độ ngẫu nhiên"}<span aria-hidden="true">↻</span></button>
        <p className={styles.announcement} role="status">{result ? `Đã tạo tọa độ, cách điểm gốc ${result.distanceMeters.toFixed(1)} mét.` : ""}</p>
        {error && <p className="error-box" role="alert">{error}</p>}

        {result ? <div className={styles.result}>
          <label htmlFor="generated-coordinate">Tọa độ mới <span>Vĩ độ, kinh độ</span></label>
          <input ref={coordinateInput} id="generated-coordinate" value={coordinateText} readOnly onFocus={event => event.currentTarget.select()} spellCheck={false} />
          <button type="button" className={styles.copyMain} onClick={() => void copy(coordinateText, "tọa độ")}>Sao chép tọa độ <span aria-hidden="true">↗</span></button>
          <div className={styles.copyParts}>
            <button type="button" onClick={() => void copy(result.latitude.toFixed(7), "vĩ độ")}>Sao chép vĩ độ</button>
            <button type="button" onClick={() => void copy(result.longitude.toFixed(7), "kinh độ")}>Sao chép kinh độ</button>
          </div>
          <p className={styles.feedback} role="status">{feedback}</p>
        </div> : <p className={styles.emptyResult}>Tọa độ mới sẽ hiện ở đây để bạn sao chép.</p>}
      </section>
    </div>
    <footer className={styles.footer}>Nemo · Tọa độ được tạo ngẫu nhiên quanh địa điểm đã chọn.</footer>
  </main>;
}
