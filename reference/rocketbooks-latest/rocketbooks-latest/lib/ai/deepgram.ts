import 'server-only';

/**
 * Thin Deepgram wrapper for the Organizer Recorder. Uses the prerecorded
 * async endpoint with diarization + utterances + smart formatting.
 *
 * Requires DEEPGRAM_API_KEY in the environment. Per the "expose AI config
 * in UI" rule, the model is intentionally not pinned in code — it lives
 * in the recorder settings row (added in a later phase). For now we
 * default to nova-3 and accept an override per call.
 *
 * Cost note: nova-3 is ~$0.0043/min as of 2026-05. A 30-minute call ≈ $0.13.
 */

const DG_BASE = 'https://api.deepgram.com/v1/listen';

export interface DeepgramUtterance {
	speakerLabel: string;
	startMs: number;
	endMs: number;
	text: string;
	confidence: number;
}

export interface DeepgramResult {
	utterances: DeepgramUtterance[];
	durationS: number;
	rawModel: string;
}

interface DgApiUtterance {
	start: number;
	end: number;
	speaker?: number;
	transcript: string;
	confidence: number;
}

interface DgApiResponse {
	metadata?: { duration?: number; model_info?: Record<string, { name?: string }> };
	results?: {
		utterances?: DgApiUtterance[];
	};
}

export interface TranscribeOpts {
	model?: string;
	mimetype?: string;
	languages?: string[];
}

/**
 * Transcribe a publicly-reachable audio URL (e.g. a Supabase signed URL).
 * Deepgram fetches the bytes itself — we pass only the URL.
 */
export async function transcribeUrl(url: string, opts: TranscribeOpts = {}): Promise<DeepgramResult> {
	const apiKey = process.env.DEEPGRAM_API_KEY;
	if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required');

	const params = new URLSearchParams({
		model: opts.model ?? 'nova-3',
		diarize: 'true',
		utterances: 'true',
		smart_format: 'true',
		punctuate: 'true',
	});
	if (opts.languages?.length) params.set('language', opts.languages[0]);

	const res = await fetch(`${DG_BASE}?${params.toString()}`, {
		method: 'POST',
		headers: {
			Authorization: `Token ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ url }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => '<unreadable>');
		throw new Error(`Deepgram ${res.status}: ${body.slice(0, 500)}`);
	}

	const json = (await res.json()) as DgApiResponse;
	return normalize(json, opts.model ?? 'nova-3');
}

function normalize(json: DgApiResponse, requestedModel: string): DeepgramResult {
	const utterances = (json.results?.utterances ?? []).map<DeepgramUtterance>((u) => ({
		speakerLabel: `S${(u.speaker ?? 0) + 1}`,
		startMs: Math.round(u.start * 1000),
		endMs: Math.round(u.end * 1000),
		text: u.transcript.trim(),
		confidence: u.confidence,
	}));

	const modelEntry = json.metadata?.model_info ? Object.values(json.metadata.model_info)[0] : undefined;
	return {
		utterances,
		durationS: Math.round(json.metadata?.duration ?? 0),
		rawModel: modelEntry?.name ?? requestedModel,
	};
}
