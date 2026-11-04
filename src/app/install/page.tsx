import type { Metadata } from "next";
import { InstallPortal } from "@/components/install-portal";
export const metadata: Metadata = { title: "Cài đặt Nemo", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function InstallPage() { return <InstallPortal />; }
