import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
const errors: Record<string, string> = {
  invalid: "Tên đăng nhập hoặc mật khẩu không đúng.",
  limited: "Đã thử quá nhiều lần. Vui lòng thử lại sau 15 phút.",
  unavailable: "Hệ thống tạm thời chưa sẵn sàng. Vui lòng thử lại sau.",
};
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  let unavailable = false;
  let admin = null;
  try { admin = await currentAdmin(); } catch { unavailable = true; }
  if (admin) redirect("/admin");
  const params = await searchParams;
  const message = unavailable ? errors.unavailable : errors[params.error || ""];
  return (
    <main className="login-shell">
      <section className="login-story" aria-label="Nemo Admin">
        <a className="brand" href="/" aria-label="Nemo Admin"><span className="brand-icon">n.</span> nemo<span className="brand-label">ADMIN</span></a>
        <div className="story-copy">
          <span className="eyebrow">KHÔNG GIAN QUẢN TRỊ</span>
          <h1>Mọi quyền truy cập.<br />Một nơi quản lý.</h1>
          <p>Quản lý khách hàng, thiết bị và thời hạn sử dụng trong một không gian riêng của bạn.</p>
          <div className="story-tags"><span>Khách hàng</span><span>Giấy phép</span><span>Thiết bị</span></div>
        </div>
        <p className="story-footer">Đơn giản để quản lý. Rõ ràng để kiểm soát.</p>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="eyebrow text-muted">DÀNH CHO QUẢN TRỊ VIÊN</span>
          <h2>Chào mừng trở lại</h2>
          <p className="subheading">Đăng nhập để mở trang quản trị của bạn.</p>
          {message && <p className="error-box" role="alert">{message}</p>}
          <form action="/api/auth/login" method="post" className="login-form">
            <label htmlFor="username">Tên đăng nhập</label>
            <input id="username" name="username" type="text" placeholder="Tên đăng nhập quản trị" autoComplete="username" maxLength={254} required />
            <label htmlFor="password">Mật khẩu</label>
            <input id="password" name="password" type="password" placeholder="Nhập mật khẩu của bạn" autoComplete="current-password" maxLength={256} required />
            <button className="primary-button" type="submit">Đăng nhập <span aria-hidden="true">↗</span></button>
          </form>
          <p className="login-note">Chỉ tài khoản quản trị đã được cấp mới có thể truy cập.</p>
        </div>
        <p className="panel-footer">Nemo Admin · Không gian riêng của bạn</p>
      </section>
    </main>
  );
}
