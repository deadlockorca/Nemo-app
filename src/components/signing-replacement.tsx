'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { formatDate } from '@/lib/management-types';
import { replacementLabels, type ReplacementContext } from '@/lib/signing-replacement-types';
import styles from './signing-sets.module.css';
export function SigningReplacement({ initial }: { initial: ReplacementContext }) {
  const [data, setData] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [setId, setSetId] = useState(''), [releaseId, setReleaseId] = useState('');
  const [issued, setIssued] = useState<{ url: string; code: string; expiresAt: string } | null>(null);
  const lock = useRef(false);
  const request = useCallback(async (path: string, body?: object) => {
    const r = await fetch('/api/admin/signing-replacements/' + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const result = await r.json(); if (!r.ok) throw new Error(result.error || 'Chưa xử lý được yêu cầu.'); return result;
  }, []);
  const reload = useCallback(async () => { setData(await request(initial.device.id)); }, [request, initial.device.id]);
  const pending = data.history.some(r => ['queued', 'signing'].includes(r.status));
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => { if (!document.hidden && !lock.current) void reload().catch(e => setError(e.message)); }, 4000);
    return () => clearInterval(timer);
  }, [pending, reload]);
  async function work(fn: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Chưa xử lý được yêu cầu.'); }
    finally { lock.current = false; setBusy(false); }
  }
  function queue(e: FormEvent) {
    e.preventDefault(); const set = data.sets.find(s => s.id === setId), release = data.releases.find(r => r.id === releaseId);
    if (!set || !release) return;
    void work(async () => { await request(data.device.id + '/queue', { deviceVersion: data.device.version, setId, setVersion: set.version, releaseId, releaseVersion: release.version }); await reload(); });
  }
  const active = data.history.some(r => ['queued','signing','ready'].includes(r.status));
  return <>
    <Link href="/admin/devices">← Thiết bị</Link>
    <header className="page-intro"><div><p className="eyebrow">CÀI LẠI NEMO</p><h1>Thay bộ ký</h1><p>{data.device.customer_name} · {data.device.label}</p></div><button disabled={busy} className="secondary-button" onClick={() => void work(reload)}>Làm mới</button></header>
    <p className="info-strip">UDID: <code>{data.device.apple_udid}</code><br />Ký và xác minh xong, bạn mới cấp link cài lại. Khi cấp link, hồ sơ chuyển sang bản cài mới; key và bản cài cũ được giữ nguyên. Khách cần mở link trong Safari để cài.</p>
    {error && <p role="alert" className="error-box">{error}</p>}
    {issued && <section className={styles.panel} aria-label="Link cài mới"><h2>Link cài lại đã sẵn sàng</h2><p>Hết hạn: {formatDate(issued.expiresAt)}. Đây là link riêng của khách; hệ thống chưa xác nhận khách đã cài app.</p>
      <input aria-label="Link cài lại" style={{ width: '100%' }} value={issued.url} readOnly onFocus={e => e.target.select()} /><div className={styles.actions}><button className="primary-button" onClick={() => void work(() => navigator.clipboard.writeText(issued.url))}>Sao chép link</button></div><p>Mã cài: <code>{issued.code}</code></p></section>}
    <section className={styles.panel}><h2>Chuẩn bị bản cài mới</h2>
      <p className="field-help">Chỉ hiện bộ ký còn hạn, có đúng UDID và có xác nhận Apple hợp lệ gần đây. Nếu chưa thấy bộ ký, kiểm tra mục Bộ ký và certificate worker.</p>
      {!data.device.license_id && <p className="error-box">Hồ sơ chưa gắn key. Hãy gắn key và cấu hình thiết bị trước.</p>}
      <form className={styles.form} onSubmit={queue}><fieldset disabled={busy || active || !data.device.license_id}>
        <label>Bộ ký mới<select value={setId} onChange={e => setSetId(e.target.value)} required><option value="">Chọn bộ ký</option>{data.sets.map(s => <option key={s.id} value={s.id}>{s.name} · {s.certificate_sha256.slice(0,12)}…</option>)}</select></label>
        <label>Phiên bản IPA trắng<select value={releaseId} onChange={e => setReleaseId(e.target.value)} required><option value="">Chọn IPA trắng</option>{data.releases.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
        <button className="primary-button" disabled={!setId || !releaseId}>Ký bản cài mới</button>
      </fieldset></form>
      {active && <p role="status">Thiết bị có yêu cầu chưa hoàn tất. Xem tiến độ bên dưới hoặc hủy yêu cầu để chọn lại.</p>}
      <p><Link href="/admin/signing-sets">Quản lý Bộ ký</Link> · <Link href="/admin/ipa-library">Thư viện IPA trắng</Link></p>
    </section>
    <section className="records-card"><div className="table-toolbar"><h2>Lịch sử thay bộ ký</h2></div><div className="table-scroll"><table className="records-table"><thead><tr><th>Bộ ký / IPA</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>
      {data.history.map(r => <tr key={r.id}><td><strong>{r.set_name}</strong><small>{r.release_label}</small><small>{formatDate(r.created_at)}</small><small>Chứng chỉ cũ: {r.old_certificate?.slice(0,16) || 'Chưa ghi nhận'}…</small><small>Chứng chỉ mới: {r.new_certificate.slice(0,16)}…</small></td>
        <td>{replacementLabels[r.status]}{r.error && <small className="danger-text">{r.error}</small>}{r.status === 'issued' && <small>{formatDate(r.issued_at)} · Chưa xác nhận khách đã cài</small>}{r.status === 'queued' && <small>Chờ signing worker xử lý</small>}</td>
        <td><div className="row-actions">{r.status === 'ready' && <button disabled={busy} className="primary-button" onClick={() => void work(async () => { const link = await request(r.id + '/issue', {}); setIssued(link); await reload(); })}>Cấp link cài lại</button>}
          {['queued','signing','ready'].includes(r.status) && <button disabled={busy} className="text-button" onClick={() => void work(async () => { await request(r.id + '/cancel', {}); await reload(); })}>Hủy yêu cầu</button>}
          {r.status === 'issued' && <Link href="/admin/installations">Cấp lại mã nếu mất link</Link>}</div></td></tr>)}
      {!data.history.length && <tr><td colSpan={3}>Chưa có yêu cầu thay bộ ký cho thiết bị này.</td></tr>}
    </tbody></table></div></section>
  </>;
}
