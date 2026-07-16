import 'server-only';
import { chatCompletion } from '@/lib/ai/openai';
import type { UsageCtx } from '@/lib/ai/usage';
import { logger } from '@/lib/logger';

export interface ActionItem {
	text: string;
	ownerSpeakerLabel: string | null;
	dueHint: string | null;
}

export interface SummaryDraft {
	summaryMd: string;
	decisions: string[];
	actionItems: ActionItem[];
}

interface SegmentInput {
	speakerLabel: string;
	startMs: number;
	text: string;
}

const SYSTEM = `You summarize meeting transcripts and extract follow-ups. The transcript has speaker labels like S1, S2 — these are *anonymous*; do not invent real names. Refer to people by their label.`;

/**
 * Draft a summary + action items from a diarized transcript. Returns
 * empty fields if the transcript is too short to be meaningful.
 */
export async function draftSummary(
	ctx: UsageCtx,
	segments: SegmentInput[],
): Promise<SummaryDraft> {
	if (segments.length === 0) {
		return { summaryMd: '', decisions: [], actionItems: [] };
	}

	const transcript = segments
		.map((s) => `[${formatTs(s.startMs)}] ${s.speakerLabel}: ${s.text}`)
		.join('\n');

	let raw: string;
	try {
		const res = await chatCompletion(
			{ ...ctx, actor: 'system', feature: 'recorder-draft-summary' },
			{
				model: 'gpt-4o-mini',
				temperature: 0.2,
				messages: [
					{ role: 'system', content: SYSTEM },
					{ role: 'user', content: `Transcript:\n${transcript}\n\nReturn a short summary (markdown, 3–6 sentences), a list of explicit decisions, and a list of follow-up action items. For each action item, set ownerSpeakerLabel to the speaker who should do it (S1, S2, …) or null if it isn't clear. Set dueHint to any time phrase mentioned ("by Friday", "this week", "next sprint"), or null.` },
				],
				response_format: {
					type: 'json_schema',
					json_schema: {
						name: 'RecordingSummary',
						strict: true,
						schema: {
							type: 'object',
							additionalProperties: false,
							required: ['summaryMd', 'decisions', 'actionItems'],
							properties: {
								summaryMd: { type: 'string' },
								decisions: { type: 'array', items: { type: 'string' } },
								actionItems: {
									type: 'array',
									items: {
										type: 'object',
										additionalProperties: false,
										required: ['text', 'ownerSpeakerLabel', 'dueHint'],
										properties: {
											text: { type: 'string' },
											ownerSpeakerLabel: { type: ['string', 'null'] },
											dueHint: { type: ['string', 'null'] },
										},
									},
								},
							},
						},
					},
				},
			},
		);
		raw = res.choices[0]?.message?.content ?? '';
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error({ err: msg }, 'recorder draft-summary openai call failed');
		throw err;
	}

	try {
		const parsed = JSON.parse(raw) as SummaryDraft;
		return {
			summaryMd: parsed.summaryMd ?? '',
			decisions: parsed.decisions ?? [],
			actionItems: parsed.actionItems ?? [],
		};
	} catch (err) {
		logger.error({ raw: raw.slice(0, 500) }, 'recorder draft-summary returned non-JSON');
		throw new Error(`Could not parse summary JSON: ${(err as Error).message}`);
	}
}

function formatTs(ms: number): string {
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
