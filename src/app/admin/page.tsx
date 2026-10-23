import Link from "next/link";
import { actionTitles } from "@/lib/management-types";
import { loadDashboard } from "@/lib/dashboard";
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const { admin, counts, events } = await loadDashboard();
  const stats = [
    ["Khách hàng", counts.customers, "Tổng khách hàng đã lưu"],
    ["Key đang dùng", counts.active, "Giấy phép còn hiệu lực"],
    ["Sắp hết hạn", counts.expiring, "Trong 7 ngày tới"],
    ["Đã hết hạn", counts.expired, "Cần được gia hạn"],
  ];
  return (
    <>
        <section className="dashboard-intro"><p className="text-muted">Chào {admin.name},</p><h1>Tổng quan hệ thống</h1><p>Theo dõi khách hàng và thời hạn sử dụng của bạn.</p></section>
        <section className="stats-grid" aria-label="Thống kê">{stats.map(([label, count, hint]) => <article className="stat-card" key={label}><h2>{label}</h2><strong>{count}</strong><p>{hint}</p></article>)}</section>
        <section className="activity-card"><div className="section-heading"><div><span className="eyebrow text-muted">NHẬT KÝ HỆ THỐNG</span><h2>Hoạt động gần đây</h2></div><span className="status-pill">Đã kết nối</span></div>
          <ul className="activity-list">{events.map((event) => <li key={event.id}><span className="activity-icon" aria-hidden="true">↗</span><div><strong>{actionTitles[event.action] || event.action}</strong><p>{event.display_name || "Hệ thống"}</p></div><time dateTime={event.created_at.toISOString()}>{new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(event.created_at)}</time></li>)}</ul>
          {events.length === 0 && <p className="empty-state">Chưa có hoạt động nào.</p>}
        </section>
        <p className="dashboard-note"><Link href="/admin/customers">Thêm khách hàng</Link> rồi <Link href="/admin/licenses">cấp key mới</Link>. Thời hạn bắt đầu ngay khi cấp key cho khách hàng.</p>
    </>
  );
}
