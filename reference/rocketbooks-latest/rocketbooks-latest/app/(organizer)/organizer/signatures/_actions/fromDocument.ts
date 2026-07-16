'use server';

import { redirect } from 'next/navigation';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';
import { getDocument } from '@/lib/documents/store';
import { createRequestFromDocument } from '@/lib/signatures/create';
import { FreezeError } from '@/lib/signatures/freeze';
import { logger } from '@/lib/logger';

/**
 * Start a signature request from a Documents item and jump straight into the
 * builder. Bound to a document id and used as a <form action> on the Documents
 * row + view page. On failure (e.g. a non-PDF upload) it bounces back to
 * Documents rather than erroring the page.
 */
export async function sendDocumentForSignatureAction(documentId: string): Promise<void> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const userId = await getEffectiveUserId();

  let id: string | null = null;
  try {
    const doc = await getDocument(orgId, documentId);
    if (doc) id = await createRequestFromDocument(orgId, userId, doc);
  } catch (err) {
    if (!(err instanceof FreezeError)) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'send-for-signature failed');
    }
  }

  // redirect() throws internally, so it must run outside the try/catch above.
  redirect(id ? `/organizer/signatures/${id}` : '/organizer/documents');
}
