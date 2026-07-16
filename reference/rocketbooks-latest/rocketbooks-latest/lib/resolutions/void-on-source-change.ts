import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	documentRecords,
	documentAuditEvents,
} from '@/db/schema/schema';
import { logger } from '@/lib/logger';

interface VoidLinkedDocsArgs {
	organizationId: string;
	sourceKind: 'deposit_finding' | 'fixed_asset';
	sourceId: string;
	reason: string;
}

/**
 * Void any auto-spawned document records that were linked to a
 * source event (a finding, an asset) once that event is reversed
 * / dismissed / removed. "Void" = status='voided' + audit event
 * 'voided_by_source_change'. We do NOT delete:
 *
 *   - signed docs carry signatures that need to stay in the audit
 *     trail (deleting them would mean rewriting history). The
 *     trustee can still see the voided doc with its signatures and
 *     decide whether to redraft a corrected one.
 *
 *   - unsigned drafts could be deleted, but keeping them voided is
 *     consistent with signed-doc behavior and lets the user see
 *     what was previously auto-drafted from this source.
 *
 * Idempotent — re-running on the same (source_kind, source_id) is a
 * no-op when there's nothing in 'draft' / 'rendering' / 'signed' state.
 */
export async function voidLinkedDocsForSource(
	args: VoidLinkedDocsArgs,
): Promise<{ voidedCount: number }> {
	const candidates = await db
		.select({ id: documentRecords.id, status: documentRecords.status })
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.organizationId, args.organizationId),
				eq(documentRecords.sourceKind, args.sourceKind),
				eq(documentRecords.sourceId, args.sourceId),
				ne(documentRecords.status, 'voided'),
			),
		);

	if (candidates.length === 0) return { voidedCount: 0 };

	const now = new Date().toISOString();
	for (const c of candidates) {
		await db
			.update(documentRecords)
			.set({ status: 'voided', updatedAt: now })
			.where(eq(documentRecords.id, c.id));
		await db.insert(documentAuditEvents).values({
			id: randomUUID(),
			documentRecordId: c.id,
			type: 'voided_by_source_change',
			metadata: {
				priorStatus: c.status,
				sourceKind: args.sourceKind,
				sourceId: args.sourceId,
				reason: args.reason,
			},
			timestamp: now,
		});
	}

	logger.info(
		{
			organizationId: args.organizationId,
			sourceKind: args.sourceKind,
			sourceId: args.sourceId,
			voidedCount: candidates.length,
		},
		'voided linked docs on source change',
	);

	return { voidedCount: candidates.length };
}
