import 'server-only';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Supabase Storage bucket for Organizer Recorder audio. Private — never
 * surface a direct URL; use signed URLs only. Audio is retained
 * indefinitely (decision deferred); a retention setting will be layered
 * on later.
 *
 * Path convention: {orgId}/{recordingId}/audio.{ext}
 *   ext is 'webm' on Chromium/Firefox, 'mp4' on iOS Safari.
 */
const BUCKET_NAME = 'recordings';
const SIGNED_URL_TTL_SECONDS = 60 * 60;
// 50 MB is Supabase's per-file cap on the free tier (and the bucket
// create call rejects anything higher). At 64 kbps opus that's ~100
// minutes of audio, which covers any single meeting we expect today.
const MAX_FILE_BYTES = 50 * 1024 * 1024;
// audio/* wildcard rather than the explicit list — browsers send
// parameterized MIMEs like `audio/webm;codecs=opus` that Supabase's
// MIME matcher doesn't normalize against the exact strings. We still
// validate the MIME server-side in the finalize route.
const ALLOWED_MIME = ['audio/*'];

let bucketEnsured = false;

async function ensureBucket(): Promise<void> {
	if (bucketEnsured) return;
	const supa = createServiceClient();
	const { error } = await supa.storage.createBucket(BUCKET_NAME, {
		public: false,
		fileSizeLimit: MAX_FILE_BYTES,
		allowedMimeTypes: ALLOWED_MIME,
	});
	if (error && !/already exists|duplicate/i.test(error.message)) {
		throw new Error(`Failed to ensure recordings bucket: ${error.message}`);
	}
	bucketEnsured = true;
}

export function recordingPath(orgId: string, recordingId: string, ext: 'webm' | 'mp4' | 'ogg' = 'webm'): string {
	return `${orgId}/${recordingId}/audio.${ext}`;
}

/**
 * Upload an audio blob (server-side). Phase 1 uploads go through the API
 * route; in a later phase we can issue signed upload URLs and let the
 * client PUT directly to the bucket to avoid the double-hop.
 */
export async function uploadRecording(
	path: string,
	body: Buffer | Uint8Array | Blob,
	contentType: string,
): Promise<void> {
	await ensureBucket();
	const supa = createServiceClient();
	const { error } = await supa.storage.from(BUCKET_NAME).upload(path, body, {
		contentType,
		upsert: true,
	});
	if (error) throw new Error(`Failed to upload recording: ${error.message}`);
}

/**
 * Short-lived signed URL the transcribe worker can hand to Deepgram.
 * Deepgram fetches the audio itself, so the URL must be reachable from
 * the public internet.
 */
export async function signedRecordingUrl(path: string): Promise<string> {
	const supa = createServiceClient();
	const { data, error } = await supa.storage.from(BUCKET_NAME).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
	if (error || !data) throw new Error(`Failed to sign recording URL: ${error?.message ?? 'unknown'}`);
	return data.signedUrl;
}

export async function deleteRecording(path: string): Promise<void> {
	const supa = createServiceClient();
	const { error } = await supa.storage.from(BUCKET_NAME).remove([path]);
	if (error) throw new Error(`Failed to delete recording: ${error.message}`);
}
