'use client';

import Link from 'next/link';

interface Props {
	/** Trust-review finding id; routed to the doc-template's prefill
	 *  resolver via the ?fromFinding query param. */
	findingId: string;
	/** Template id the finding maps to. Today only
	 *  'distribution-authorization' is supported; expand as more
	 *  finding→template mappings land. */
	templateId: string;
	/** Hover tooltip override; defaults to a "draft the resolution"
	 *  hint based on templateId. */
	title?: string;
}

/**
 * Per-row affordance that jumps to /trust-documents/new with the
 * template + finding pre-selected. The new page reads ?fromFinding
 * and server-loads the values into the form, so the user sees a
 * mostly-filled form ready for the judgment-call fields (purpose,
 * standard applied, etc.).
 *
 * Modeled on AddReceiptButton — a small icon-style action sitting
 * with the other per-row buttons in the trust-review queue. Cyan
 * to distinguish from the existing actions (rose=dismiss,
 * violet=beneficiary, amber=trustee, etc.).
 */
export function DraftResolutionButton({ findingId, templateId, title }: Props) {
	const href = `/trust-documents/new?template=${encodeURIComponent(templateId)}&fromFinding=${encodeURIComponent(findingId)}`;
	const label = title ?? 'Draft resolution PDF for this finding';
	return (
		<Link
			href={href}
			title={label}
			aria-label={label}
			className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-cyan-300 bg-cyan-50 text-cyan-700 transition-colors hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300 dark:hover:bg-cyan-900/50"
		>
			<svg
				viewBox="0 0 24 24"
				width="14"
				height="14"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
				<polyline points="14 2 14 8 20 8" />
				<line x1="9" y1="13" x2="15" y2="13" />
				<line x1="9" y1="17" x2="13" y2="17" />
			</svg>
		</Link>
	);
}
