import { requireAdmin } from '@/lib/auth';
import { replacementContext } from '@/lib/signing-replacements';
import { SigningReplacement } from '@/components/signing-replacement';
import { InputError } from '@/lib/validation';
import { notFound } from 'next/navigation';
export default async function ReplaceSigningPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const data = await replacementContext((await params).id).catch(e => {
    if (e instanceof InputError) notFound();
    throw e;
  });
  return <SigningReplacement initial={JSON.parse(JSON.stringify(data))} />;
}
