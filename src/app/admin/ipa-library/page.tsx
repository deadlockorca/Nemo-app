import { requireAdmin } from "@/lib/auth";
import { listIpaReleases } from "@/lib/ipa-releases";
import { IpaLibrary } from "@/components/ipa-library";
export default async function IpaLibraryPage() {
  await requireAdmin();
  return <IpaLibrary initial={JSON.parse(JSON.stringify(await listIpaReleases(new URLSearchParams())))} />;
}
