import 'server-only';
import { z } from 'zod';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { TemplateDefinition, RenderArgs } from '../types';

/**
 * Schedule A — the master inventory of every asset currently in trust
 * corpus. Functions as both the Initial Trust Asset Schedule (revision
 * 1, signed at funding) and the Schedule A Amendment (revision 2+,
 * regenerated after each new contribution event). One template covers
 * both cases — the revision number distinguishes them.
 *
 * Auto-generated from fixed_assets where acquisitionType is
 * 'contributed' or 'inherited'. Bill of Sale is the per-event source
 * document; Schedule A is the consolidated current-state ledger that
 * an attorney or CPA asks for first at audit time.
 *
 * Variables are snapshotted at draft time (not re-queried on render)
 * so the document is reproducible — re-rendering the same record
 * always produces the same PDF, even if fixed_assets has changed
 * since.
 */

const ASSET_ITEM_SCHEMA = z.object({
	name: z.string(),
	categoryName: z.string().optional().nullable(),
	acquisitionType: z.enum(['contributed', 'inherited']),
	costBasisCents: z.number().int().nonnegative(),
	fmvCents: z.number().int().nonnegative().optional().nullable(),
	inServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	assetNumber: z.string().optional().nullable(),
	serialNumber: z.string().optional().nullable(),
	location: z.string().optional().nullable(),
});

const VARIABLES_SCHEMA = z.object({
	/** 1 = Initial Trust Asset Schedule. 2+ = Amendment, regenerated
	 *  after a new contribution event. Drives the title + numbering. */
	revision: z.number().int().positive(),
	/** Snapshot date — generally today; the user can backdate when
	 *  reconstructing historical schedules. */
	asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	/** Optional cover note. Useful for Amendments ("added one
	 *  vehicle on 2026-05-10") or for noting reconciliation against
	 *  Bill of Sale references. */
	notes: z.string().optional().nullable(),
	/** The asset rows themselves. */
	assets: z.array(ASSET_ITEM_SCHEMA),
});

type ScheduleAVariables = z.infer<typeof VARIABLES_SCHEMA>;

const styles = StyleSheet.create({
	page: {
		paddingTop: 56,
		paddingBottom: 64,
		paddingHorizontal: 48,
		fontFamily: 'Helvetica',
		fontSize: 10,
		lineHeight: 1.4,
		color: '#1f2937',
	},
	title: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 18,
		textAlign: 'center',
		marginBottom: 4,
		color: '#0f172a',
		letterSpacing: 1,
	},
	subtitle: {
		fontSize: 10,
		textAlign: 'center',
		color: '#64748b',
		marginBottom: 20,
	},
	hr: {
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		marginBottom: 20,
	},
	intro: {
		marginBottom: 16,
		textAlign: 'justify',
	},
	emph: {
		fontFamily: 'Helvetica-Bold',
	},
	tableHeader: {
		flexDirection: 'row',
		borderBottomWidth: 1,
		borderBottomColor: '#0f172a',
		paddingBottom: 4,
		marginBottom: 4,
	},
	tableHeaderCell: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 8.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
	},
	row: {
		flexDirection: 'row',
		paddingVertical: 5,
		borderBottomWidth: 0.5,
		borderBottomColor: '#e2e8f0',
	},
	col_n: { width: '5%' },
	col_desc: { width: '38%', paddingRight: 6 },
	col_class: { width: '14%', paddingRight: 6 },
	col_basis: { width: '14%', textAlign: 'right' },
	col_fmv: { width: '14%', textAlign: 'right' },
	col_date: { width: '15%', textAlign: 'right' },
	cellMain: {
		fontSize: 9.5,
		color: '#0f172a',
	},
	cellSub: {
		fontSize: 8,
		color: '#64748b',
		marginTop: 1,
	},
	cellSubMono: {
		fontSize: 8,
		fontFamily: 'Courier',
		color: '#64748b',
		marginTop: 1,
	},
	totals: {
		flexDirection: 'row',
		marginTop: 12,
		paddingTop: 8,
		borderTopWidth: 1,
		borderTopColor: '#0f172a',
	},
	totalsLabel: {
		flex: 1,
		fontFamily: 'Helvetica-Bold',
		fontSize: 10,
		color: '#0f172a',
	},
	totalsValue: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 10,
		color: '#0f172a',
		textAlign: 'right',
	},
	notesBlock: {
		marginTop: 20,
		padding: 10,
		backgroundColor: '#f8fafc',
		borderRadius: 4,
	},
	notesLabel: {
		fontFamily: 'Helvetica-Bold',
		fontSize: 8.5,
		color: '#475569',
		textTransform: 'uppercase',
		letterSpacing: 0.4,
		marginBottom: 4,
	},
	notesBody: {
		fontSize: 10,
		color: '#0f172a',
	},
	signaturesHeader: {
		marginTop: 32,
		marginBottom: 6,
		fontSize: 10,
		letterSpacing: 1.5,
		color: '#0f172a',
		fontFamily: 'Helvetica-Bold',
	},
	sigRow: {
		flexDirection: 'row',
		gap: 28,
		marginTop: 12,
	},
	sigBlock: {
		flex: 1,
	},
	sigLineRule: {
		borderBottomWidth: 0.75,
		borderBottomColor: '#0f172a',
		marginBottom: 4,
		marginTop: 28,
	},
	sigLabel: {
		fontSize: 9,
		color: '#64748b',
	},
	sigName: {
		fontSize: 10,
		fontFamily: 'Helvetica-Bold',
		color: '#0f172a',
		marginBottom: 2,
	},
	sigMeta: {
		fontSize: 8,
		color: '#64748b',
		marginTop: 2,
	},
	emptyState: {
		marginTop: 24,
		padding: 14,
		backgroundColor: '#fef3c7',
		borderRadius: 4,
		fontSize: 10,
		color: '#92400e',
	},
	footer: {
		position: 'absolute',
		bottom: 32,
		left: 48,
		right: 48,
		fontSize: 8,
		color: '#94a3b8',
		textAlign: 'center',
		borderTopWidth: 0.5,
		borderTopColor: '#cbd5e1',
		paddingTop: 6,
	},
});

const ACQ_LABEL: Record<ScheduleAVariables['assets'][number]['acquisitionType'], string> = {
	contributed: 'Contributed',
	inherited: 'Inherited',
};

function formatMoney(cents: number): string {
	return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	const dt = new Date(Date.UTC(y, m - 1, d));
	return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function titleFor(rev: number): string {
	if (rev === 1) return 'SCHEDULE A — INITIAL TRUST ASSET SCHEDULE';
	return `SCHEDULE A — AMENDMENT ${rev - 1}`;
}

function scheduleAPdf(args: RenderArgs<ScheduleAVariables>) {
	const v = args.variables;
	const trust = args.trust;
	const trustLabel = trust.trustName ?? 'the Trust';
	const trustee = args.signers.find((s) => s.role.toLowerCase().includes('trustee'));
	const grantor = args.signers.find((s) => s.role.toLowerCase().includes('grantor') || s.role.toLowerCase().includes('settlor'));

	const totalBasisCents = v.assets.reduce((acc, a) => acc + a.costBasisCents, 0);
	const totalFmvCents = v.assets.reduce((acc, a) => acc + (a.fmvCents ?? a.costBasisCents), 0);

	const introCopy = v.revision === 1
		? `This Schedule A enumerates the assets contributed to ${trustLabel} at initial funding. Each item is identified by description, asset class, basis, fair market value, and acquisition reference. The corresponding Bills of Sale (or equivalent transfer instruments) are incorporated by reference and retained with the trust records.`
		: `This Amendment ${v.revision - 1} to Schedule A reflects the corpus of ${trustLabel} as of ${formatDate(v.asOfDate)}, incorporating all contributions made since prior funding. The corresponding Bills of Sale or transfer instruments for newly-added assets are incorporated by reference.`;

	return (
		<Document>
			<Page size="LETTER" style={styles.page}>
				<Text style={styles.title}>{titleFor(v.revision)}</Text>
				<Text style={styles.subtitle}>
					{trustLabel}{trust.ein ? ` · EIN ${trust.ein}` : ''} · as of {formatDate(v.asOfDate)}
				</Text>
				<View style={styles.hr} />

				<Text style={styles.intro}>{introCopy}</Text>

				{v.assets.length === 0 ? (
					<View style={styles.emptyState}>
						<Text>
							No assets in corpus yet. Add contributed or inherited assets via the Assets page; this Schedule
							will populate automatically on the next draft.
						</Text>
					</View>
				) : (
					<>
						<View style={styles.tableHeader}>
							<Text style={[styles.tableHeaderCell, styles.col_n]}>#</Text>
							<Text style={[styles.tableHeaderCell, styles.col_desc]}>Description</Text>
							<Text style={[styles.tableHeaderCell, styles.col_class]}>Class / Type</Text>
							<Text style={[styles.tableHeaderCell, styles.col_basis]}>Cost basis</Text>
							<Text style={[styles.tableHeaderCell, styles.col_fmv]}>FMV</Text>
							<Text style={[styles.tableHeaderCell, styles.col_date]}>In service</Text>
						</View>

						{v.assets.map((a, idx) => (
							<View key={idx} style={styles.row} wrap={false}>
								<Text style={[styles.cellMain, styles.col_n]}>{idx + 1}</Text>
								<View style={styles.col_desc}>
									<Text style={styles.cellMain}>{a.name}</Text>
									{(a.assetNumber || a.serialNumber || a.location) && (
										<Text style={styles.cellSubMono}>
											{[
												a.assetNumber ? `#${a.assetNumber}` : null,
												a.serialNumber ? `SN ${a.serialNumber}` : null,
												a.location ? a.location : null,
											].filter(Boolean).join(' · ')}
										</Text>
									)}
								</View>
								<View style={styles.col_class}>
									<Text style={styles.cellMain}>{a.categoryName ?? '—'}</Text>
									<Text style={styles.cellSub}>{ACQ_LABEL[a.acquisitionType]}</Text>
								</View>
								<Text style={[styles.cellMain, styles.col_basis]}>{formatMoney(a.costBasisCents)}</Text>
								<Text style={[styles.cellMain, styles.col_fmv]}>
									{a.fmvCents != null ? formatMoney(a.fmvCents) : '—'}
								</Text>
								<Text style={[styles.cellMain, styles.col_date]}>{formatDate(a.inServiceDate)}</Text>
							</View>
						))}

						<View style={styles.totals}>
							<Text style={styles.totalsLabel}>
								Totals ({v.assets.length} asset{v.assets.length === 1 ? '' : 's'})
							</Text>
							<View style={{ width: '14%' }}>
								<Text style={styles.totalsValue}>{formatMoney(totalBasisCents)}</Text>
							</View>
							<View style={{ width: '14%' }}>
								<Text style={styles.totalsValue}>{formatMoney(totalFmvCents)}</Text>
							</View>
							<View style={{ width: '15%' }} />
						</View>
					</>
				)}

				{v.notes && (
					<View style={styles.notesBlock}>
						<Text style={styles.notesLabel}>Notes</Text>
						<Text style={styles.notesBody}>{v.notes}</Text>
					</View>
				)}

				<Text style={styles.signaturesHeader}>SIGNATURES</Text>

				<View style={styles.sigRow}>
					<View style={styles.sigBlock}>
						<View style={styles.sigLineRule} />
						<Text style={styles.sigName}>{trustee?.signedName ?? trustee?.expectedName ?? 'Trustee'}</Text>
						<Text style={styles.sigLabel}>Trustee of {trustLabel}</Text>
						{trustee?.signedAt && (
							<Text style={styles.sigMeta}>
								Signed {trustee.signedAt}{trustee.signedIp ? ` · IP ${trustee.signedIp}` : ''}
							</Text>
						)}
					</View>
					<View style={styles.sigBlock}>
						<View style={styles.sigLineRule} />
						<Text style={styles.sigName}>
							{grantor?.signedName ?? grantor?.expectedName ?? trust.grantorName ?? 'Grantor / Settlor'}
						</Text>
						<Text style={styles.sigLabel}>
							{v.revision === 1 ? 'Grantor / Settlor — acknowledging the schedule' : 'Grantor / Settlor — acknowledging the amendment'}
						</Text>
						{grantor?.signedAt && (
							<Text style={styles.sigMeta}>
								Signed {grantor.signedAt}{grantor.signedIp ? ` · IP ${grantor.signedIp}` : ''}
							</Text>
						)}
					</View>
				</View>

				<Text style={styles.footer}>
					Generated {formatDate(args.draftedAt.slice(0, 10))} · Document id pending · Template schedule-a v1
				</Text>
			</Page>
		</Document>
	);
}

export const scheduleATemplate: TemplateDefinition<ScheduleAVariables> = {
	id: 'schedule-a',
	version: '1',
	label: 'Schedule A — Trust Asset Schedule',
	description:
		'Master inventory of every asset in trust corpus. Auto-generated from the fixed-asset register; revision 1 is the Initial Schedule signed at funding, revision 2+ are Amendments regenerated after each contribution event.',
	category: 'corpus',
	variablesSchema: VARIABLES_SCHEMA,
	requiredSignerRoles: [
		{ role: 'Trustee' },
		{ role: 'Grantor / Settlor' },
	],
	requiresState: true,
	renderPdf: scheduleAPdf,
};
