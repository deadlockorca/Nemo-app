"use client";
export default function AdminError({ reset }: { reset: () => void }) {
  return <main className="error-page"><h1>Chưa thể tải trang quản trị</h1><p>Kết nối dữ liệu đang bị gián đoạn. Vui lòng thử lại sau.</p><button className="primary-button" onClick={reset}>Thử lại</button></main>;
}
