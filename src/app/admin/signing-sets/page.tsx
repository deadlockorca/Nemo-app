import { requireAdmin } from '@/lib/auth';
import { listSigningSets } from '@/lib/signing-sets';
import { SigningSets } from '@/components/signing-sets';
export default async function SigningSetsPage() {
  await requireAdmin();
  return <SigningSets initial={JSON.parse(JSON.stringify(await listSigningSets(new URLSearchParams())))} />;
}
