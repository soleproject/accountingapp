import 'server-only';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * Supabase Storage bucket for trustee resolutions and uploaded trust
 * documents. Private (signed-URL only) — these are legal artifacts and
 * we never want them addressable by direct URL even if a path leaks.
 *
 * Path conventions inside the bucket:
 *
 *   {orgId}/{documentRecordId}/v{versionNumber}.pdf
 *     — system-generated resolutions, one PDF per saved version
 *
 *   {orgId}/uploads/{documentRecordId}/{filename}
 *     — user uploads (the trust instrument, proprietary templates,
 *       counter-signed PDFs, etc.). Original filename preserved for
 *       audit clarity.
 */
const BUCKET_NAME = 'trust-documents';
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const ALLOWED_MIME = [
	'application/pdf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/msword',
	'image/png',
	'image/jpeg',
];
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — large enough for scanned signed PDFs

let bucketEnsured = false;

/**
 * Idempotently create the bucket if it doesn't exist. Called by the
 * upload helpers on the first call per process. Failure modes:
 *
 *   - Bucket already exists → no-op (createBucket returns a "already
 *     exists" error which we swallow)
 *   - Service-role key missing / wrong → throws so callers fail fast
 *     instead of silently writing to a non-existent location
 *
 * Idempotent across server processes — uses a module-level flag to
 * skip the API roundtrip after the first successful call.
 */
async function ensureBucket(): Promise<void> {
	if (bucketEnsured) return;
	const supa = createServiceClient();
	const { error } = await supa.storage.createBucket(BUCKET_NAME, {
		public: false,
		fileSizeLimit: MAX_FILE_BYTES,
		allowedMimeTypes: ALLOWED_MIME,
	});
	// "Bucket already exists" — Supabase returns a specific error
	// shape we want to swallow. Anything else is a real problem.
	if (error && !/already exists|duplicate/i.test(error.message)) {
		throw new Error(`Failed to ensure trust-documents bucket: ${error.message}`);
	}
	bucketEnsured = true;
}

export interface UploadedObject {
	bucket: string;
	path: string;
}

/**
 * Upload a generated resolution PDF for a specific document record +
 * version. Overwrites any object at the same path (upsert semantics)
 * so re-rendering a version replaces in place — the version-history
 * row in document_versions is the source of truth for what existed.
 */
export async function uploadResolutionPdf(args: {
	organizationId: string;
	documentRecordId: string;
	versionNumber: number;
	pdfBytes: Uint8Array;
}): Promise<UploadedObject> {
	await ensureBucket();
	const path = `${args.organizationId}/${args.documentRecordId}/v${args.versionNumber}.pdf`;
	const supa = createServiceClient();
	const { error } = await supa.storage.from(BUCKET_NAME).upload(path, args.pdfBytes, {
		contentType: 'application/pdf',
		upsert: true,
	});
	if (error) throw new Error(`Storage upload failed (${path}): ${error.message}`);
	logger.info({ path, bytes: args.pdfBytes.length }, 'resolution PDF uploaded');
	return { bucket: BUCKET_NAME, path };
}

/**
 * Upload a user-supplied document (trust instrument, proprietary
 * template, counter-signed scan, etc.) under the document_record's
 * uploads namespace. `filename` is preserved verbatim so the audit
 * trail can reference what the user dropped.
 */
export async function uploadUserDocument(args: {
	organizationId: string;
	documentRecordId: string;
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}): Promise<UploadedObject> {
	await ensureBucket();
	// Strip path separators from the filename so a malicious upload
	// can't escape its document_records-scoped prefix.
	const safeName = args.filename.replace(/[/\\]+/g, '_');
	const path = `${args.organizationId}/uploads/${args.documentRecordId}/${safeName}`;
	const supa = createServiceClient();
	const { error } = await supa.storage.from(BUCKET_NAME).upload(path, args.bytes, {
		contentType: args.contentType,
		upsert: true,
	});
	if (error) throw new Error(`Storage upload failed (${path}): ${error.message}`);
	return { bucket: BUCKET_NAME, path };
}

/**
 * Time-limited download link. Use for previewing or downloading from
 * the UI. Never return raw bucket URLs.
 */
export async function getResolutionSignedUrl(path: string): Promise<string> {
	await ensureBucket();
	const supa = createServiceClient();
	const { data, error } = await supa.storage
		.from(BUCKET_NAME)
		.createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
	if (error || !data) {
		throw new Error(`Signed-URL generation failed (${path}): ${error?.message ?? 'unknown'}`);
	}
	return data.signedUrl;
}

export const TRUST_DOCUMENTS_BUCKET = BUCKET_NAME;
