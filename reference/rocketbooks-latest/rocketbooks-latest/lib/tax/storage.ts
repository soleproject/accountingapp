// Storage helpers for the tax feature — archived blank forms (knowledge layer) and
// completed filled forms (filing layer) both live in one private bucket. Server-only
// (uses the service-role client, matching lib/storage/signatures.ts).

import { createServiceClient } from "@/lib/supabase/service";

export const TAX_FORMS_BUCKET = "tax-forms";

// Supabase per-file cap is 50 MB; stay under it. Tax PDFs are well under 25 MB.
const FILE_SIZE_LIMIT = 25 * 1024 * 1024;

export async function ensureTaxBucket(): Promise<void> {
	const sb = createServiceClient();
	const { error } = await sb.storage.createBucket(TAX_FORMS_BUCKET, {
		public: false,
		fileSizeLimit: FILE_SIZE_LIMIT,
	});
	if (error && !/already exists|duplicate/i.test(error.message)) {
		throw new Error(`createBucket(${TAX_FORMS_BUCKET}) failed: ${error.message}`);
	}
}

/** Archived blank form, deduped by content hash — shared across all orgs (knowledge layer). */
export function blankFormPath(jurisdiction: string, taxYear: number, formCode: string, sha256: string): string {
	return `blank/${jurisdiction}/${taxYear}/${formCode}-${sha256.slice(0, 12)}.pdf`;
}

/** A completed form instance for one return (org-scoped data, filing layer). */
export function filledFormPath(returnId: string, formNodeId: string): string {
	return `filled/${returnId}/${formNodeId}.pdf`;
}

/** An uploaded source document (W-2/1099/etc.) for one return, before extraction. */
export function uploadedDocPath(returnId: string, sha256: string): string {
	return `uploads/${returnId}/${sha256.slice(0, 16)}.pdf`;
}

export async function uploadPdf(path: string, bytes: Uint8Array): Promise<void> {
	const sb = createServiceClient();
	const { error } = await sb.storage
		.from(TAX_FORMS_BUCKET)
		.upload(path, Buffer.from(bytes), { contentType: "application/pdf", upsert: true });
	if (error) throw new Error(`upload ${path} failed: ${error.message}`);
}

export async function downloadPdf(path: string): Promise<Uint8Array> {
	const sb = createServiceClient();
	const { data, error } = await sb.storage.from(TAX_FORMS_BUCKET).download(path);
	if (error || !data) throw new Error(`download ${path} failed: ${error?.message ?? "no data"}`);
	return new Uint8Array(await data.arrayBuffer());
}

/** Remove archived objects (cleanup / test teardown). */
export async function removePdfs(paths: string[]): Promise<void> {
	const sb = createServiceClient();
	await sb.storage.from(TAX_FORMS_BUCKET).remove(paths);
}

const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Time-limited download link for a stored tax PDF (the bucket is private). */
export async function getTaxPdfSignedUrl(path: string): Promise<string | null> {
	const sb = createServiceClient();
	const { data, error } = await sb.storage.from(TAX_FORMS_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
	if (error || !data) return null;
	return data.signedUrl;
}
