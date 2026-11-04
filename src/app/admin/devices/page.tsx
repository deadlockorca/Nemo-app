import { requireAdmin } from "@/lib/auth";
import { listRecords } from "@/lib/management";
import { listDeviceProfiles } from "@/lib/device-profiles";
import { DeviceProfiles } from "@/components/device-profiles";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdmin();
  const q = ((await searchParams).q || "").slice(0, 120);
  const [profiles, bindings] = await Promise.all([listDeviceProfiles(new URLSearchParams({ q })), listRecords("devices", new URLSearchParams())]);
  return <DeviceProfiles initial={JSON.parse(JSON.stringify(profiles))} bindings={JSON.parse(JSON.stringify(bindings))} initialQuery={q} />;
}
