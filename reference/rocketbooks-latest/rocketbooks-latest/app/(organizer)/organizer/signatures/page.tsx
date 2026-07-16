import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { listDocuments } from '@/lib/documents/store';
import { listRequests } from '@/lib/signatures/store';
import { SignaturesList } from './_components/SignaturesList';

/** Signatures — DocuSign-style e-signing. Lists requests and starts new ones
 *  from a Documents item or a fresh PDF upload. */
export default async function SignaturesPage() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  const [requests, docs] = await Promise.all([listRequests(orgId), listDocuments(orgId, userId)]);

  // Only PDFs can be signed in v1: created docs (rendered to PDF) and uploaded PDFs.
  const eligibleDocs = docs
    .filter((d) => d.source !== 'uploaded' || d.mimeType === 'application/pdf')
    .map((d) => ({ id: d.id, title: d.title || d.originalFilename || 'Untitled', source: d.source }));

  return <SignaturesList requests={requests} docs={eligibleDocs} />;
}
