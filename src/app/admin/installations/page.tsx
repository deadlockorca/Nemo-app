import { requireAdmin } from "@/lib/auth";
import { adminInstallations } from "@/lib/installations";
import { Installations } from "@/components/installations";
export default async function InstallationsPage() {
  await requireAdmin();
  return <Installations initial={JSON.parse(JSON.stringify(await adminInstallations()))} />;
}
