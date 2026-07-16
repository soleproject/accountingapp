import 'server-only';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * Supabase Storage bucket for the Signatures feature — frozen source PDFs,
 * drawn-signature PNGs, and final stamped PDFs. Private (signed-URL only):
 * these are legal artifacts and must never be addressable by direct URL.
 *
 * Path conventions inside the bucket:
 *
 *   {orgId}/{requestId}/source.pdf                 — frozen signing document
 *   {orgId}/{requestId}/signed/{recipientId}-{fieldId}.png — a drawn signature
 *   {orgId}/{requestId}/completed.pdf              — final stamped document
 */
const BUCKET_NAME = 'signatures';
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

let bucketEnsured = false;

async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const supa = createServiceClient();
  const { error } = await supa.storage.createBucket(BUCKET_NAME, {
    public: false,
    fileSizeLimit: MAX_FILE_BYTES,
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Failed to ensure signatures bucket: ${error.message}`);
  }
  bucketEnsured = true;
}

/** Upload bytes to a path inside the signatures bucket (upsert). */
export async function uploadSignatureObject(args: {
  path: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<void> {
  await ensureBucket();
  const supa = createServiceClient();
  const { error } = await supa.storage.from(BUCKET_NAME).upload(args.path, args.bytes, {
    contentType: args.contentType,
    upsert: true,
  });
  if (error) throw new Error(`Signatures upload failed (${args.path}): ${error.message}`);
  logger.info({ path: args.path, bytes: args.bytes.length }, 'signature object uploaded');
}

/** Download bytes from the signatures bucket (e.g. the source PDF to stamp). */
export async function downloadSignatureObject(path: string): Promise<Uint8Array> {
  await ensureBucket();
  const supa = createServiceClient();
  const { data, error } = await supa.storage.from(BUCKET_NAME).download(path);
  if (error || !data) throw new Error(`Signatures download failed (${path}): ${error?.message ?? 'unknown'}`);
  return new Uint8Array(await data.arrayBuffer());
}

/** Time-limited download link for previewing/serving a signatures object. */
export async function getSignatureSignedUrl(path: string): Promise<string> {
  await ensureBucket();
  const supa = createServiceClient();
  const { data, error } = await supa.storage.from(BUCKET_NAME).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`Signatures signed-URL failed (${path}): ${error?.message ?? 'unknown'}`);
  }
  return data.signedUrl;
}

export const SIGNATURES_BUCKET = BUCKET_NAME;
