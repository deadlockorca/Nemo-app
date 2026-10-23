import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nemo Admin",
  description: "Quản trị khách hàng và giấy phép sử dụng",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
