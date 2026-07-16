import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { listDocuments } from '@/lib/documents/store';
import { DocumentsView } from './_components/DocumentsView';

/** Saved standalone documents: created drafts (reopen into the Create canvas
 *  via ?doc=<id>) and uploaded files (open via a signed URL). The client view
 *  splits them across All / Created / Uploaded tabs. */
export default async function DocumentsPage() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();
  const docs = await listDocuments(orgId, userId);

  return <DocumentsView docs={docs} />;
}
