import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { AdminNav } from "@/components/admin-nav";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  return <div className="admin-shell">
    <aside className="sidebar">
      <Link className="brand" href="/admin"><span className="brand-icon">n.</span> nemo<span className="brand-label">ADMIN</span></Link>
      <AdminNav />
      <div className="sidebar-account"><span className="avatar">{admin.name.slice(0, 1).toUpperCase()}</span><div><strong>{admin.name}</strong><small>Quản trị viên</small></div></div>
    </aside>
    <main className="dashboard">
      <header className="dashboard-header"><span className="eyebrow text-muted">KHÔNG GIAN QUẢN TRỊ</span><form action="/api/auth/logout" method="post"><button className="secondary-button" type="submit">Đăng xuất ↗</button></form></header>
      {children}
    </main>
  </div>;
}
