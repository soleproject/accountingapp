import 'server-only';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * Supabase Storage bucket for user-uploaded organizer documents (the
 * "Uploaded" tab on /organizer/documents). Private — served only via
 * short-lived signed URLs, never addressable directly.
 *
 * Path convention inside the bucket:
 *
 *   {orgId}/{documentId}/{filename}
 *     — one object per organizer_documents row whose source = 'uploaded'.
 *       Original filename preserved (path-separators stripped) so the
 *       download lands with a sensible name.
 */
const BUCKET_NAME = 'organizer-documents';
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export const ORGANIZER_DOC_ALLOWED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
  'text/markdown',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

// 25 MB — comfortably under Supabase's 50 MB per-file cap (createBucket
// rejects fileSizeLimit above the cap with a misleading error).
export const ORGANIZER_DOC_MAX_BYTES = 25 * 1024 * 1024;

let bucketEnsured = false;

/**
 * Idempotently create the bucket if it doesn't exist. Module-level flag
 * skips the API roundtrip after the first success per process. Swallows
 * the "already exists" error; rethrows anything else (e.g. a bad
 * service-role key) so callers fail fast.
 */
async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const supa = createServiceClient();
  const { error } = await supa.storage.createBucket(BUCKET_NAME, {
    public: false,
    fileSizeLimit: ORGANIZER_DOC_MAX_BYTES,
    allowedMimeTypes: ORGANIZER_DOC_ALLOWED_MIME,
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Failed to ensure organizer-documents bucket: ${error.message}`);
  }
  bucketEnsured = true;
}

export interface UploadedObject {
  bucket: string;
  path: string;
}

/**
 * Store an uploaded organizer document. One object per documentId; the
 * filename is preserved (path-separators stripped so an upload can't
 * escape its org/document prefix). Upsert so re-uploading replaces in
 * place.
 */
export async function uploadOrganizerDocument(args: {
  organizationId: string;
  documentId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<UploadedObject> {
  await ensureBucket();
  const safeName = args.filename.replace(/[/\\]+/g, '_');
  const path = `${args.organizationId}/${args.documentId}/${safeName}`;
  const supa = createServiceClient();
  const { error } = await supa.storage.from(BUCKET_NAME).upload(path, args.bytes, {
    contentType: args.contentType,
    upsert: true,
  });
  if (error) throw new Error(`Storage upload failed (${path}): ${error.message}`);
  logger.info({ path, bytes: args.bytes.length }, 'organizer document uploaded');
  return { bucket: BUCKET_NAME, path };
}

/** Raw bytes of an uploaded document (e.g. to freeze a PDF for signing). */
export async function downloadOrganizerDocument(path: string): Promise<Uint8Array> {
  await ensureBucket();
  const supa = createServiceClient();
  const { data, error } = await supa.storage.from(BUCKET_NAME).download(path);
  if (error || !data) throw new Error(`Organizer document download failed (${path}): ${error?.message ?? 'unknown'}`);
  return new Uint8Array(await data.arrayBuffer());
}

/** Time-limited download link. Never return raw bucket URLs. */
export async function getOrganizerDocumentSignedUrl(path: string): Promise<string> {
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

/** Best-effort delete of an uploaded object (used when removing a row). */
export async function deleteOrganizerDocument(path: string): Promise<void> {
  await ensureBucket();
  const supa = createServiceClient();
  const { error } = await supa.storage.from(BUCKET_NAME).remove([path]);
  if (error) logger.error({ path, err: error.message }, 'organizer document delete failed (non-fatal)');
}

export const ORGANIZER_DOCUMENTS_BUCKET = BUCKET_NAME;
