"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const links = [["/admin", "Tổng quan"], ["/admin/customers", "Khách hàng"], ["/admin/licenses", "Quản lý key"], ["/admin/devices", "Thiết bị"], ["/admin/installations", "Cài đặt Nemo"], ["/admin/ipa-library", "IPA trắng"], ["/locations", "Công cụ vị trí ↗"], ["/admin/activity", "Lịch sử"]];
export function AdminNav() {
  const pathname = usePathname();
  return <nav aria-label="Quản trị">{links.map(([href, title]) => <Link key={href} href={href} className={pathname === href ? "nav-active" : ""} aria-current={pathname === href ? "page" : undefined}>{title}{pathname === href && <span aria-hidden="true">↗</span>}</Link>)}</nav>;
}
