'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDocumentSignedUrl } from '../../_actions/getDocumentSignedUrl';

interface Props {
	documentRecordId: string;
	hasPdf: boolean;
	status: string;
}

/**
 * PDF preview surface. While the document is still rendering, polls
 * the server every 2s to detect when the PDF lands, then fetches a
 * short-lived signed URL and embeds the PDF in an iframe. On
 * subsequent updates (e.g., re-render after signature) the parent
 * page revalidates and we refetch the URL.
 */
export function DocumentPreview({ documentRecordId, hasPdf, status }: Props) {
	const router = useRouter();
	const [url, setUrl] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Poll for the PDF to land while rendering.
	useEffect(() => {
		if (status !== 'rendering') return;
		const tick = () => router.refresh();
		const i = setInterval(tick, 2000);
		return () => clearInterval(i);
	}, [status, router]);

	// Resolve a signed URL whenever the upstream pdf_url exists. Signed
	// URLs are scoped per-request and short-lived; we re-resolve on every
	// status change so the iframe always shows the latest version.
	useEffect(() => {
		if (!hasPdf) {
			setUrl(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		(async () => {
			const r = await getDocumentSignedUrl({ documentRecordId });
			if (cancelled) return;
			setLoading(false);
			if (!r.ok || !r.url) {
				setError(r.error ?? 'Could not load preview');
				return;
			}
			setUrl(r.url);
		})();
		return () => {
			cancelled = true;
		};
	}, [documentRecordId, hasPdf, status]);

	return (
		<section className="overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10">
			<div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
				<span>Preview</span>
				{url && (
					<a
						href={url}
						target="_blank"
						rel="noopener noreferrer"
						className="text-blue-600 hover:underline dark:text-blue-400"
					>
						Open in new tab ↗
					</a>
				)}
			</div>
			<div className="h-[80vh] bg-zinc-50 dark:bg-zinc-950">
				{status === 'rendering' && !url ? (
					<div className="flex h-full items-center justify-center text-sm text-zinc-500">
						Rendering PDF — usually a few seconds.
					</div>
				) : loading ? (
					<div className="flex h-full items-center justify-center text-sm text-zinc-500">
						Loading preview…
					</div>
				) : error ? (
					<div className="flex h-full items-center justify-center text-sm text-red-600 dark:text-red-400">
						{error}
					</div>
				) : url ? (
					<iframe src={url} className="h-full w-full" title="Document preview" />
				) : (
					<div className="flex h-full items-center justify-center text-sm text-zinc-500">
						No PDF yet.
					</div>
				)}
			</div>
		</section>
	);
}
