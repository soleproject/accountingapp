/**
 * One-off: update the 'recordings' bucket to allow audio/* MIME types
 * (covers the parameterized `audio/webm;codecs=opus` Chrome emits).
 * Run with: npx tsx scripts/update-recordings-bucket.ts
 *
 * Idempotent — runs both ensure + update so it's safe whether the
 * bucket already exists or not.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

const BUCKET_NAME = 'recordings';
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME = ['audio/*'];

async function main() {
	// Don't import lib/supabase/service.ts — it has `import 'server-only'`
	// which blocks usage from scripts. Construct the client directly.
	const { createClient } = await import('@supabase/supabase-js');
	const supa = createClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.SUPABASE_SERVICE_ROLE_KEY!,
		{ auth: { autoRefreshToken: false, persistSession: false } },
	);

	const created = await supa.storage.createBucket(BUCKET_NAME, {
		public: false,
		fileSizeLimit: MAX_FILE_BYTES,
		allowedMimeTypes: ALLOWED_MIME,
	});
	if (created.error && !/already exists|duplicate/i.test(created.error.message)) {
		throw new Error(`createBucket: ${created.error.message}`);
	}

	const updated = await supa.storage.updateBucket(BUCKET_NAME, {
		public: false,
		fileSizeLimit: MAX_FILE_BYTES,
		allowedMimeTypes: ALLOWED_MIME,
	});
	if (updated.error) throw new Error(`updateBucket: ${updated.error.message}`);

	console.log(`✓ bucket '${BUCKET_NAME}' configured with allowedMimeTypes=${JSON.stringify(ALLOWED_MIME)}`);
	process.exit(0);
}

main().catch((err) => {
	console.error('✗ failed:', err);
	process.exit(1);
});
