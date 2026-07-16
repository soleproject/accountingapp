import 'server-only';
import { randomUUID } from 'crypto';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * Public Supabase Storage bucket for slide-deck images — both AI-generated
 * (PNG) and re-hosted free stock photos (JPEG/WebP). Public so the canvas
 * preview (<img>) and the .pptx exporter can load them by URL, and so the URL
 * persists in the deck body (an `imgsrc:` line) — no regeneration on reopen.
 * Path: {orgId}/{uuid}.{ext}
 */
const BUCKET_NAME = 'deck-images';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

let bucketEnsured = false;

async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const supa = createServiceClient();
  const { error } = await supa.storage.createBucket(BUCKET_NAME, {
    public: true,
    fileSizeLimit: MAX_FILE_BYTES,
    allowedMimeTypes: ALLOWED_MIME,
  });
  if (error && !/already exists|duplicate/i.test(error.message)) {
    throw new Error(`Failed to ensure deck-images bucket: ${error.message}`);
  }
  // The bucket may pre-date stock support (png-only); widen the mime allow-list.
  await supa.storage.updateBucket(BUCKET_NAME, { public: true, allowedMimeTypes: ALLOWED_MIME, fileSizeLimit: MAX_FILE_BYTES }).catch(() => {});
  bucketEnsured = true;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Upload image bytes (PNG/JPEG/WebP) and return the public URL. */
export async function uploadDeckImage(orgId: string, bytes: Uint8Array, contentType = 'image/png'): Promise<string> {
  await ensureBucket();
  const ext = EXT[contentType] ?? 'png';
  const path = `${orgId}/${randomUUID()}.${ext}`;
  const supa = createServiceClient();
  const { error } = await supa.storage.from(BUCKET_NAME).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error(`Deck image upload failed (${path}): ${error.message}`);
  const { data } = supa.storage.from(BUCKET_NAME).getPublicUrl(path);
  logger.info({ path, bytes: bytes.length }, 'deck image uploaded');
  return data.publicUrl;
}
