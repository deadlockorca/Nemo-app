import { requireAdmin } from "@/lib/auth";
import { listRecords, type Section } from "@/lib/management";
import { Management } from "./management";
import type { ListData } from "@/lib/management-types";
export async function ManagementPage({ section }: { section: Section }) {
  await requireAdmin();
  const data = await listRecords(section, new URLSearchParams());
  const initial = JSON.parse(JSON.stringify(data)) as ListData;
  return <Management section={section} initial={initial} />;
}
