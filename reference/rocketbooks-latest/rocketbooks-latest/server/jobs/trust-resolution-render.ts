import 'server-only';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { inngest } from '@/lib/inngest';
import { db } from '@/db/client';
import {
	documentRecords,
	documentAuditEvents,
} from '@/db/schema/schema';
import { renderAndStoreResolution } from '@/lib/resolutions/render-and-store';
import { logger } from '@/lib/logger';

/**
 * Render-then-store worker for trust resolution drafts. Triggered by
 * the `draftResolution` server action via Inngest event
 * `trust/resolution.requested`. The actual work lives in
 * `lib/resolutions/render-and-store.ts` so the dev fallback in the
 * draft action can re-use it inline when the Inngest dev server
 * isn't listening locally.
 *
 * Concurrency keyed on the document id so a re-render request can't
 * race itself. Retries on transient failures (storage hiccups,
 * network); permanent failures (bad variables) flip the row to
 * 'failed' and surface in the audit log.
 */
export const trustResolutionRender = inngest.createFunction(
	{
		id: 'trust-resolution-render',
		concurrency: { limit: 1, key: 'event.data.documentRecordId' },
		retries: 2,
		triggers: [{ event: 'trust/resolution.requested' }],
	},
	async ({ event, step }) => {
		const { documentRecordId } = event.data as { documentRecordId: string };

		await step.run('render-and-store', async () => {
			try {
				await renderAndStoreResolution(documentRecordId);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await db
					.update(documentRecords)
					.set({ status: 'failed', updatedAt: new Date().toISOString() })
					.where(eq(documentRecords.id, documentRecordId));
				await db.insert(documentAuditEvents).values({
					id: randomUUID(),
					documentRecordId,
					type: 'render_failed',
					metadata: { error: msg },
					timestamp: new Date().toISOString(),
				});
				throw err;
			}
		});

		logger.info({ documentRecordId }, 'trust-resolution-render complete');
	},
);
