import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	contacts,
	documentRecords,
	documentVersions,
	documentAuditEvents,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getTemplate } from '@/lib/resolutions/registry';
import type { Signer } from '@/lib/resolutions/types';
import { DocumentActions } from './_components/DocumentActions';
import { DocumentPreview } from './_components/DocumentPreview';
import { SignaturePanel } from './_components/SignaturePanel';

interface PageProps {
	params: Promise<{ id: string }>;
}

const STATUS_PALETTE: Record<string, string> = {
	rendering: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
	draft: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
	signed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
	failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

export default async function DocumentDetailPage({ params }: PageProps) {
	const orgId = await getCurrentOrgId();
	const { id } = await params;

	const [doc] = await db
		.select({
			id: documentRecords.id,
			templateId: documentRecords.templateId,
			templateVersion: documentRecords.templateVersion,
			status: documentRecords.status,
			signers: documentRecords.signers,
			pdfUrl: documentRecords.pdfUrl,
			createdAt: documentRecords.createdAt,
			updatedAt: documentRecords.updatedAt,
		})
		.from(documentRecords)
		.where(
			and(
				eq(documentRecords.id, id),
				eq(documentRecords.organizationId, orgId),
			),
		)
		.limit(1);
	if (!doc) notFound();

	const tmpl = getTemplate(doc.templateId);
	const signers = (doc.signers ?? []) as Signer[];

	const versions = await db
		.select({
			id: documentVersions.id,
			versionNumber: documentVersions.versionNumber,
			createdAt: documentVersions.createdAt,
			pdfUrl: documentVersions.pdfUrl,
		})
		.from(documentVersions)
		.where(eq(documentVersions.documentRecordId, id))
		.orderBy(asc(documentVersions.versionNumber));

	const events = await db
		.select({
			id: documentAuditEvents.id,
			type: documentAuditEvents.type,
			metadata: documentAuditEvents.metadata,
			timestamp: documentAuditEvents.timestamp,
		})
		.from(documentAuditEvents)
		.where(eq(documentAuditEvents.documentRecordId, id))
		.orderBy(asc(documentAuditEvents.timestamp));

	// Active trustees roster — fed to the signature panel so the
	// Trustee signer row renders as a picker instead of free-text. We
	// only surface currently-acting trustees (trusteeRemovedAt IS NULL);
	// former trustees stay in the contacts table for audit but
	// shouldn't appear as signing options on new documents.
	const trustees = await db
		.select({
			id: contacts.id,
			contactName: contacts.contactName,
			trusteeRole: contacts.trusteeRole,
		})
		.from(contacts)
		.where(
			and(
				eq(contacts.organizationId, orgId),
				eq(contacts.isActive, true),
				isNull(contacts.trusteeRemovedAt),
				// trustee_role IS NOT NULL OR the legacy 'trustee' tag is
				// present on type_tags. Phase 0 added trustee_role but we
				// don't backfill — the type_tags fallback lets existing
				// trustees show up without a manual edit.
				sql`(${contacts.trusteeRole} IS NOT NULL OR ${contacts.typeTags}::jsonb ? 'trustee')`,
			),
		)
		.orderBy(asc(contacts.contactName));

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<Link
					href="/trust-documents"
					className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
				>
					← All trust documents
				</Link>
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="flex items-center gap-3">
							<h1 className="text-2xl font-semibold">{tmpl?.label ?? doc.templateId}</h1>
							<span
								className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
									STATUS_PALETTE[doc.status] ?? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
								}`}
							>
								{doc.status}
							</span>
						</div>
						<div className="mt-1 font-mono text-xs text-zinc-500">{doc.id}</div>
					</div>
					<DocumentActions
						documentRecordId={doc.id}
						canEdit={!signers.some((s) => !!s.signedAt)}
						signedCount={signers.filter((s) => !!s.signedAt).length}
					/>
				</div>
			</div>

			<div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
				<DocumentPreview
					documentRecordId={doc.id}
					hasPdf={!!doc.pdfUrl}
					status={doc.status}
				/>

				<aside className="flex flex-col gap-4">
					<SignaturePanel
						documentRecordId={doc.id}
						signers={signers}
						trustees={trustees}
					/>

					<section className="rounded-xl border border-zinc-300 bg-white p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10">
						<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
							Versions
						</h2>
						{versions.length === 0 ? (
							<div className="text-xs text-zinc-500">No versions rendered yet.</div>
						) : (
							<ul className="flex flex-col gap-1 text-sm">
								{versions.map((v) => (
									<li key={v.id} className="flex items-center justify-between">
										<span>v{v.versionNumber}</span>
										<span className="text-xs text-zinc-500">{v.createdAt.slice(0, 16).replace('T', ' ')}</span>
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="rounded-xl border border-zinc-300 bg-white p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10">
						<h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
							Audit trail
						</h2>
						<ul className="flex flex-col gap-2 text-xs">
							{events.map((e) => (
								<li key={e.id}>
									<div className="font-medium text-zinc-800 dark:text-zinc-200">{e.type}</div>
									<div className="text-zinc-500">{e.timestamp.slice(0, 19).replace('T', ' ')}</div>
								</li>
							))}
						</ul>
					</section>
				</aside>
			</div>
		</div>
	);
}
