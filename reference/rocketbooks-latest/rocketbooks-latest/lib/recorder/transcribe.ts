import 'server-only';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { recordings, recordingSegments, recordingOutputs } from '@/db/schema/schema';
import { signedRecordingUrl } from '@/lib/storage/recordings';
import { transcribeUrl } from '@/lib/ai/deepgram';
import { recordServiceUsage } from '@/lib/ai/usage';
import { draftSummary } from '@/lib/recorder/draft-summary';
import { logger } from '@/lib/logger';

/**
 * Transcribe one recording: resolve a fetchable audio URL, call Deepgram,
 * write segments, set status='ready'. On failure, set status='failed'
 * with a failure_reason and rethrow so the caller can surface it.
 *
 * Audio source:
 *   - device path (mic/tab): no opts — we sign the recording's
 *     storage_path in the supabase 'recordings' bucket.
 *   - meeting-bot path (Recall): the webhook passes opts.audioUrl (Recall's
 *     own download URL). Deepgram fetches it directly; no storage_path.
 *
 * Phase 1 runs this inline inside the finalize handler; the bot webhook
 * also calls it inline. If meeting lengths push past a route's maxDuration
 * ceiling, we'll move this to an Inngest function — the function body stays
 * the same, only the caller changes.
 */
export async function runTranscription(
	recordingId: string,
	opts: { audioUrl?: string } = {},
): Promise<void> {
	const [rec] = await db
		.select({
			storagePath: recordings.storagePath,
			organizationId: recordings.organizationId,
			userId: recordings.userId,
		})
		.from(recordings)
		.where(eq(recordings.id, recordingId))
		.limit(1);
	if (!rec) {
		throw new Error(`recording ${recordingId} not found`);
	}
	if (!opts.audioUrl && !rec.storagePath) {
		throw new Error(`recording ${recordingId} has no storage_path or audioUrl`);
	}

	await db
		.update(recordings)
		.set({ status: 'transcribing', updatedAt: new Date().toISOString() })
		.where(eq(recordings.id, recordingId));

	try {
		const url = opts.audioUrl ?? (await signedRecordingUrl(rec.storagePath as string));
		const result = await transcribeUrl(url);

		// Billable transcription minutes (Deepgram bills by audio duration).
		recordServiceUsage(
			{ userId: rec.userId, orgId: rec.organizationId, actor: 'system', feature: 'recorder-transcription' },
			{ provider: 'deepgram', category: 'transcription', unit: 'minutes', quantity: result.durationS / 60, rateKey: 'deepgram:minute', model: result.rawModel },
		);

		// Recall.ai bot recording cost — meeting-bot path only. opts.audioUrl is
		// set when the Recall webhook hands us its recording; device captures
		// (mic/tab) don't use Recall, so they incur no recording charge.
		if (opts.audioUrl) {
			recordServiceUsage(
				{ userId: rec.userId, orgId: rec.organizationId, actor: 'system', feature: 'recorder-bot-recording' },
				{ provider: 'recall', category: 'recording', unit: 'hours', quantity: result.durationS / 3600, rateKey: 'recall:recording-hour' },
			);
		}

		if (result.utterances.length > 0) {
			await db.insert(recordingSegments).values(
				result.utterances.map((u) => ({
					id: randomUUID(),
					recordingId,
					speakerLabel: u.speakerLabel,
					startMs: u.startMs,
					endMs: u.endMs,
					text: u.text,
				})),
			);
		}

		// Draft summary + action items. Best-effort: if the LLM call fails,
		// we still mark the recording ready so the transcript is usable;
		// the UI exposes a "regenerate summary" path for that case.
		let summaryOk = true;
		try {
			const draft = await draftSummary(
				{ userId: rec.userId, orgId: rec.organizationId, actor: 'system', feature: 'recorder-summary' },
				result.utterances,
			);
			await db
				.insert(recordingOutputs)
				.values({
					id: randomUUID(),
					recordingId,
					summaryMd: draft.summaryMd,
					actionItems: draft.actionItems,
					decisions: draft.decisions,
				})
				.onConflictDoUpdate({
					target: recordingOutputs.recordingId,
					set: {
						summaryMd: draft.summaryMd,
						actionItems: draft.actionItems,
						decisions: draft.decisions,
						generatedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				});
		} catch (err) {
			summaryOk = false;
			const msg = err instanceof Error ? err.message : String(err);
			logger.warn({ recordingId, err: msg }, 'recorder summary draft failed; transcript saved without summary');
		}

		await db
			.update(recordings)
			.set({
				status: 'ready',
				durationS: result.durationS || null,
				failureReason: summaryOk ? null : 'summary_draft_failed',
				updatedAt: new Date().toISOString(),
			})
			.where(eq(recordings.id, recordingId));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error({ recordingId, err: msg }, 'transcription failed');
		await db
			.update(recordings)
			.set({
				status: 'failed',
				failureReason: msg.slice(0, 1000),
				updatedAt: new Date().toISOString(),
			})
			.where(eq(recordings.id, recordingId));
		throw err;
	}
}
