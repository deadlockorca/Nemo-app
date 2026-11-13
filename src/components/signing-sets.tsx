'use client';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { formatDate } from '@/lib/management-types';
import { signingStatus, type SigningSet, type SigningSetList, type SigningSetDetail } from '@/lib/signing-set-types';
import styles from './signing-sets.module.css';

const endpoint = '/api/admin/signing-sets';
async function api(path = '', init?: RequestInit) {
  const response = await fetch(endpoint + path, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Không thực hiện được thao tác.');
  return data;
}
export function SigningSets({ initial }: { initial: SigningSetList }) {
  const [list, setList] = useState(initial), [detail, setDetail] = useState<SigningSetDetail | null>(null);
  const [q, setQ] = useState(''), [state, setState] = useState('active');
  const [deviceQ, setDeviceQ] = useState(''), [mode, setMode] = useState('linked');
  const [upload, setUpload] = useState(false), [edit, setEdit] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  const locked = useRef(false);
  async function work(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setSuccess('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Thao tác chưa thành công.'); }
    finally { locked.current = false; setBusy(false); }
  }
  async function refresh(page = 1) { setList(await api('?' + new URLSearchParams({ q, state, page: String(page) }))); }
  async function show(setId: string, page = 1, nextMode = mode, search = deviceQ) {
    setDetail(await api('/' + setId + '?' + new URLSearchParams({ mode: nextMode, q: search, page: String(page) })));
  }
  function open(set: SigningSet) { void work(async () => { setMode('linked'); setDeviceQ(''); setEdit(false); await show(set.id, 1, 'linked', ''); }); }
  async function change(action: string, body: Record<string, unknown> = {}) {
    if (!detail) return;
    await api('/' + detail.set.id + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: detail.set.version, ...body }) });
    await show(detail.set.id, detail.page); await refresh(list.page);
    setSuccess('Đã lưu. Bộ ký của bản cài hiện tại không thay đổi.');
  }
  function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    void work(async () => {
      const created = await api('', { method: 'POST', body: data });
      form.reset(); setUpload(false); await refresh(); setMode('linked'); setDeviceQ('');
      await show(created.id, 1, 'linked', ''); setSuccess('Đã thêm bộ ký. Trạng thái Apple sẽ cập nhật qua worker theo dõi chứng chỉ.');
    });
  }
  return <>
    <header className="page-intro"><div><p className="eyebrow">KHO CHỨNG CHỈ</p><h1>Bộ ký</h1><p>Quản lý chứng chỉ, profile và các thiết bị được phép sử dụng.</p></div>
      <button className="primary-button" disabled={busy} onClick={() => { setUpload(!upload); setError(''); }}>Thêm bộ ký</button></header>
    <p className="info-strip">Liên kết để quản lý trong kho. Thao tác này chưa thay bộ ký, ký lại IPA hay cấp link cài mới cho khách.</p>
    <div role="status" aria-live="polite">{success && <p className="success-box">{success}</p>}</div>
    {error && <p role="alert" className="error-box">{error} <button className="text-button" disabled={busy} onClick={() => void work(async () => { await refresh(list.page); if (detail) await show(detail.set.id, detail.page); })}>Tải lại dữ liệu</button></p>}
    {upload && <section className={styles.panel} aria-label="Thêm bộ ký"><h2>Thêm bộ ký</h2>
      <form onSubmit={submitUpload} className={styles.form}><fieldset disabled={busy}>
        <label>Tên bộ ký<input name="name" maxLength={160} required placeholder="Ví dụ: Bộ ký tháng 11 – nhóm A" /></label>
        <div className={styles.grid}><label>Tệp .p12 (tối đa 1 MB)<input type="file" name="p12" accept=".p12,.pfx" required /></label>
          <label>Profile (tối đa 2 MB)<input type="file" name="profile" accept=".mobileprovision" required /></label></div>
        <label>Mật khẩu .p12<input name="password" type="password" maxLength={1024} autoComplete="new-password" /></label>
        <label>Ghi chú<textarea name="notes" maxLength={2000} rows={2} /></label>
        <p className="field-help">Tệp và mật khẩu được lưu mã hóa. Danh sách chỉ hiển thị thông tin chứng chỉ và profile; không có chức năng tải khóa riêng xuống.</p>
        <div className={styles.actions}><button className="primary-button" type="submit">{busy ? 'Đang kiểm tra…' : 'Kiểm tra và lưu'}</button><button type="button" className="text-button" onClick={() => setUpload(false)}>Hủy</button></div>
      </fieldset></form></section>}
    <section className="records-card" aria-label="Danh sách bộ ký">
      <form className="table-toolbar" onSubmit={e => { e.preventDefault(); void work(() => refresh()); }}>
        <input aria-label="Tìm bộ ký" placeholder="Tên hoặc SHA-256 chứng chỉ" value={q} onChange={e => setQ(e.target.value)} maxLength={160} />
        <select aria-label="Trạng thái kho" value={state} onChange={e => setState(e.target.value)}><option value="active">Đang quản lý</option><option value="archived">Đã lưu trữ</option><option value="all">Tất cả</option></select>
        <button disabled={busy} type="submit">Tìm / làm mới</button>
      </form>
      <div className="table-scroll"><table className="records-table"><thead><tr><th>Bộ ký</th><th>Chứng chỉ Apple</th><th>Profile</th><th>Thiết bị</th><th /></tr></thead>
        <tbody>{list.items.map(set => <tr key={set.id}><td><strong>{set.name}</strong><small className={styles.muted}>{set.metadata.team} · {set.state === 'archived' ? 'Đã lưu trữ' : 'Đang quản lý'}</small></td>
          <td><span className={styles[set.certificate_status]}>{signingStatus[set.certificate_status]}</span><small className={styles.muted}>Hạn: {formatDate(set.metadata.certificateExpiresAt)}</small></td>
          <td>{set.metadata.profileName}<small className={styles.muted}>Hạn: {formatDate(set.metadata.profileExpiresAt)}</small></td>
          <td>{set.linked_count} liên kết<small className={styles.muted}>{set.observed_count} hồ sơ cùng chứng chỉ</small></td><td><button disabled={busy} className="text-button" onClick={() => open(set)}>Chi tiết</button></td></tr>)}
          {!list.items.length && <tr><td colSpan={5}>Chưa có bộ ký phù hợp. Bộ ký của bản cài cũ vẫn được giữ nguyên.</td></tr>}</tbody></table></div>
      <div className="table-pagination"><span>{list.total} bộ ký · Trang {list.page}/{list.pages}</span><button disabled={busy || list.page <= 1} onClick={() => void work(() => refresh(list.page - 1))}>Trước</button><button disabled={busy || list.page >= list.pages} onClick={() => void work(() => refresh(list.page + 1))}>Sau</button></div>
    </section>
    {detail && <section className={styles.panel} aria-label="Chi tiết bộ ký">
      <div className={styles.actions}><h2>{detail.set.name}</h2><button className="text-button" onClick={() => setDetail(null)} disabled={busy}>Đóng</button></div>
      <div className={styles.grid}><div><p><strong>{signingStatus[detail.set.certificate_status]}</strong></p><p>Kiểm tra gần nhất: {formatDate(detail.set.checked_at)}</p><p>Hạn chứng chỉ: {formatDate(detail.set.metadata.certificateExpiresAt)}</p><p>Hạn profile: {formatDate(detail.set.metadata.profileExpiresAt)}</p></div>
        <div><p>Team: {detail.set.metadata.team} · {detail.set.metadata.signingMode}</p><p>Profile UUID: <code>{detail.set.metadata.profileUuid}</code></p><p>App: <code>{detail.set.metadata.applicationIdentifier}</code></p><p>SHA-256: <code className={styles.digest}>{detail.set.certificate_sha256}</code></p></div></div>
      <p className={styles.notes}>{detail.set.notes || 'Chưa có ghi chú.'}</p>
      <details><summary>{detail.set.metadata.udids.length} UDID được profile cho phép</summary><div className={styles.udids}>{detail.set.metadata.udids.map(d => <code key={d}>{d}</code>)}</div></details>
      <div className={styles.actions}><button className="text-button" disabled={busy} onClick={() => setEdit(!edit)}>Sửa tên / ghi chú</button>
        <button className="text-button" disabled={busy} onClick={() => void work(() => change(detail.set.state === 'active' ? 'archive' : 'restore'))}>{detail.set.state === 'active' ? 'Lưu trữ bộ ký' : 'Khôi phục bộ ký'}</button></div>
      {edit && <form key={detail.set.id + ':' + detail.set.version} className={styles.form} onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void work(async () => { await change('edit', { name: data.get('name'), notes: data.get('notes') }); setEdit(false); }); }}>
        <fieldset disabled={busy}><label>Tên<input name="name" required maxLength={160} defaultValue={detail.set.name} /></label><label>Ghi chú<textarea name="notes" maxLength={2000} defaultValue={detail.set.notes} /></label><button className="primary-button">Lưu</button></fieldset></form>}
      <h3>Thiết bị</h3><p className="field-help">“Hồ sơ cùng chứng chỉ” được đối chiếu từ bản cài hoặc profile theo dõi đã gắn, chưa xác nhận app đang chạy trên máy. Một chứng chỉ có thể nằm trong nhiều bộ ký.</p>
      <form className="table-toolbar" onSubmit={e => { e.preventDefault(); void work(() => show(detail.set.id)); }}>
        <select aria-label="Lọc thiết bị" value={mode} onChange={e => setMode(e.target.value)}><option value="linked">Đã liên kết trong kho</option><option value="observed">Hồ sơ cùng chứng chỉ</option><option value="all">Tìm thiết bị để liên kết</option></select>
        <input aria-label="Tìm thiết bị" value={deviceQ} onChange={e => setDeviceQ(e.target.value)} placeholder="Khách hàng, thiết bị hoặc UDID" maxLength={160} /><button disabled={busy}>Xem</button>
      </form>
      <div className="table-scroll"><table className="records-table"><thead><tr><th>Khách / thiết bị</th><th>UDID</th><th>Đối chiếu</th><th /></tr></thead><tbody>
        {detail.devices.map(d => <tr key={d.id}><td><strong>{d.customer_name}</strong><small className={styles.muted}>{d.label}</small></td><td><code>{d.apple_udid}</code></td>
          <td>{d.eligible ? 'Có trong profile' : 'Không có trong profile'}{d.observed && <small className={styles.muted}>Hồ sơ cùng chứng chỉ</small>}{d.linked && d.linked_udid !== d.apple_udid.toUpperCase() && <small className={styles.revoked}>UDID đã thay đổi — cần gỡ và liên kết lại</small>}</td>
          <td><Link className="text-button" href={`/admin/devices/${d.id}/replace-signing`}>Thay bộ ký</Link><br /><button className="text-button" disabled={busy || (!d.linked && (!d.eligible || detail.set.state !== 'active'))} onClick={() => void work(() => change(d.linked ? 'unlink' : 'link', { deviceId: d.id, deviceVersion: d.version }))}>{d.linked ? 'Gỡ liên kết' : 'Liên kết'}</button></td></tr>)}
        {!detail.devices.length && <tr><td colSpan={4}>Không có thiết bị phù hợp. Chọn “Tìm thiết bị để liên kết” để thêm.</td></tr>}
      </tbody></table></div>
      <div className="table-pagination"><span>{detail.total} thiết bị · Trang {detail.page}/{detail.pages}</span><button disabled={busy || detail.page <= 1} onClick={() => void work(() => show(detail.set.id, detail.page - 1))}>Trước</button><button disabled={busy || detail.page >= detail.pages} onClick={() => void work(() => show(detail.set.id, detail.page + 1))}>Sau</button></div>
    </section>}
  </>;
}
