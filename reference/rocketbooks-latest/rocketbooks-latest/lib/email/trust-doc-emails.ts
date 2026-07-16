import 'server-only';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	documentRecords,
	documentAuditEvents,
	users,
} from '@/db/schema/schema';
import { sendTransactionalEmail, isResendConfigured } from './resend';
import { getTemplate } from '@/lib/resolutions/registry';
import { loadTrustHeader } from '@/lib/resolutions/trust-header';
import type { Signer } from '@/lib/resolutions/types';
import { logger } from '@/lib/logger';

/**
 * Per-document email notifications. Two events today:
 *
 *   notifyDraftReady   — fires after a draft renders, telling whoever
 *                        spawned it that a PDF is ready to review.
 *   notifySignedFully  — fires when the last required signer signs,
 *                        telling every signer (and the spawner) that
 *                        the doc is complete.
 *
 * Recipients today: the user who initiated the action (looked up via
 * the most recent 'drafted' / 'signed' audit event's metadata.userId).
 * Signers WITHOUT a captured email (typed-name only) are not included
 * — we don't have an addressable recipient. The notification falls
 * back to the initiator in that case.
 *
 * Each send writes a 'notification_sent' / 'notification_failed' /
 * 'notification_skipped' audit event so the trail records what
 * outbound mail this org actually generated.
 */

const APP_BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

interface AuditEventOpts {
	documentRecordId: string;
	type: 'notification_sent' | 'notification_failed' | 'notification_skipped';
	metadata: Record<string, unknown>;
}

async function writeAuditEvent(opts: AuditEventOpts): Promise<void> {
	await db.insert(documentAuditEvents).values({
		id: randomUUID(),
		documentRecordId: opts.documentRecordId,
		type: opts.type,
		metadata: opts.metadata,
		timestamp: new Date().toISOString(),
	});
}

async function loadInitiatorEmail(documentRecordId: string): Promise<string | null> {
	// Find the most recent 'drafted' audit event; its metadata.userId is
	// who kicked off the draft. Look up their email from the users table.
	const events = await db
		.select({ metadata: documentAuditEvents.metadata })
		.from(documentAuditEvents)
		.where(
			and(
				eq(documentAuditEvents.documentRecordId, documentRecordId),
				eq(documentAuditEvents.type, 'drafted'),
			),
		)
		.orderBy(documentAuditEvents.timestamp)
		.limit(1);
	const meta = (events[0]?.metadata ?? null) as { userId?: string } | null;
	if (!meta?.userId) return null;
	const [u] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, meta.userId))
		.limit(1);
	return u?.email ?? null;
}

/**
 * Notify the user who drafted that the PDF has rendered.
 */
export async function notifyDraftReady(args: { documentRecordId: string }): Promise<void> {
	try {
		if (!isResendConfigured()) {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_skipped',
				metadata: { kind: 'draft_ready', reason: 'RESEND_API_KEY not configured' },
			});
			return;
		}

		const [doc] = await db
			.select({
				id: documentRecords.id,
				organizationId: documentRecords.organizationId,
				templateId: documentRecords.templateId,
			})
			.from(documentRecords)
			.where(eq(documentRecords.id, args.documentRecordId))
			.limit(1);
		if (!doc || !doc.organizationId) return;

		const to = await loadInitiatorEmail(args.documentRecordId);
		if (!to) {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_skipped',
				metadata: { kind: 'draft_ready', reason: 'no initiator email on file' },
			});
			return;
		}

		const template = getTemplate(doc.templateId);
		const label = template?.label ?? doc.templateId;
		const trust = await loadTrustHeader(doc.organizationId);
		const trustLabel = trust.trustName ?? 'your trust';
		const url = `${APP_BASE}/trust-documents/${doc.id}`;

		const subject = `Draft ready: ${label} (${trustLabel})`;
		const text = [
			`Your ${label} draft for ${trustLabel} is ready to review and sign.`,
			'',
			`Open the document: ${url}`,
			'',
			'— RocketSuite',
		].join('\n');
		const html = `
			<p>Your <strong>${escapeHtml(label)}</strong> draft for ${escapeHtml(trustLabel)} is ready to review and sign.</p>
			<p><a href="${url}">Open the document</a></p>
			<p style="color:#6b7280;font-size:12px;margin-top:24px">— RocketSuite</p>
		`;

		const r = await sendTransactionalEmail({ to, subject, text, html, brandForOrgId: doc.organizationId, usage: { userId: null, orgId: doc.organizationId, actor: 'system', feature: 'trust-doc-email' } });
		if (r.sent) {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_sent',
				metadata: { kind: 'draft_ready', to, providerMessageId: r.id ?? null },
			});
		} else {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_failed',
				metadata: { kind: 'draft_ready', to, error: r.error ?? 'unknown' },
			});
		}
	} catch (err) {
		logger.warn(
			{ documentRecordId: args.documentRecordId, err: err instanceof Error ? err.message : err },
			'notifyDraftReady threw (non-fatal)',
		);
	}
}

/**
 * Notify all signers + the initiator that every signer has signed
 * and the doc is fully executed.
 */
export async function notifySignedFully(args: { documentRecordId: string }): Promise<void> {
	try {
		if (!isResendConfigured()) {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_skipped',
				metadata: { kind: 'signed_fully', reason: 'RESEND_API_KEY not configured' },
			});
			return;
		}

		const [doc] = await db
			.select({
				id: documentRecords.id,
				organizationId: documentRecords.organizationId,
				templateId: documentRecords.templateId,
				signers: documentRecords.signers,
			})
			.from(documentRecords)
			.where(eq(documentRecords.id, args.documentRecordId))
			.limit(1);
		if (!doc || !doc.organizationId) return;

		const signers = (doc.signers ?? []) as Signer[];
		// Signers with the typed-name flow don't carry email addresses
		// today. The initiator is the reliable address.
		const initiatorEmail = await loadInitiatorEmail(args.documentRecordId);
		const recipients = new Set<string>();
		if (initiatorEmail) recipients.add(initiatorEmail);

		if (recipients.size === 0) {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_skipped',
				metadata: { kind: 'signed_fully', reason: 'no recipients resolvable' },
			});
			return;
		}

		const template = getTemplate(doc.templateId);
		const label = template?.label ?? doc.templateId;
		const trust = await loadTrustHeader(doc.organizationId);
		const trustLabel = trust.trustName ?? 'your trust';
		const url = `${APP_BASE}/trust-documents/${doc.id}`;
		const signerList = signers.map((s) => `${s.role}: ${s.signedName ?? '(pending)'}`).join('\n');

		const subject = `Fully signed: ${label} (${trustLabel})`;
		const text = [
			`Every required signer has signed the ${label} for ${trustLabel}.`,
			'',
			'Signers:',
			signerList,
			'',
			`Open the document: ${url}`,
			'',
			'— RocketSuite',
		].join('\n');
		const html = `
			<p>Every required signer has signed the <strong>${escapeHtml(label)}</strong> for ${escapeHtml(trustLabel)}.</p>
			<p><strong>Signers:</strong></p>
			<ul>${signers.map((s) => `<li>${escapeHtml(s.role)}: ${escapeHtml(s.signedName ?? '(pending)')}</li>`).join('')}</ul>
			<p><a href="${url}">Open the document</a></p>
			<p style="color:#6b7280;font-size:12px;margin-top:24px">— RocketSuite</p>
		`;

		const to = Array.from(recipients);
		const r = await sendTransactionalEmail({ to, subject, text, html, brandForOrgId: doc.organizationId, usage: { userId: null, orgId: doc.organizationId, actor: 'system', feature: 'trust-doc-email' } });
		if (r.sent) {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_sent',
				metadata: { kind: 'signed_fully', to, providerMessageId: r.id ?? null },
			});
		} else {
			await writeAuditEvent({
				documentRecordId: args.documentRecordId,
				type: 'notification_failed',
				metadata: { kind: 'signed_fully', to, error: r.error ?? 'unknown' },
			});
		}
	} catch (err) {
		logger.warn(
			{ documentRecordId: args.documentRecordId, err: err instanceof Error ? err.message : err },
			'notifySignedFully threw (non-fatal)',
		);
	}
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
