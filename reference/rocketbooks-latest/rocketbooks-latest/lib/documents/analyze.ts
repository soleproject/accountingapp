import 'server-only';
import { chatCompletion } from '@/lib/ai/openai';
import { logger } from '@/lib/logger';

export interface DocumentBreakdown {
  /** Short label for what kind of document this is, e.g. "LLC Resolution". */
  documentType: string;
  /** One or two sentences: what the document is. */
  summary: string;
  /** What it's for / when you'd use it. */
  purpose: string;
  /** 3–6 short bullets: parties, dates, obligations, action items, blanks to fill. */
  keyPoints: string[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    documentType: { type: 'string' },
    summary: { type: 'string' },
    purpose: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
  },
  required: ['documentType', 'summary', 'purpose', 'keyPoints'],
} as const;

interface AnalyzeInput {
  orgId: string;
  userId: string | null;
  kind: string;
  title: string;
  /** Full text for created drafts; empty for binary uploads. */
  body: string;
  source: string;
  filename?: string | null;
  mimeType?: string | null;
}

function buildPrompt(input: AnalyzeInput): string {
  if (input.source === 'uploaded' && input.body.trim().length === 0) {
    // No extracted text for binary uploads yet — reason from metadata only and
    // be explicit that this is a best guess from the file name/type.
    return [
      'A user uploaded a file to their business document library. You only have its metadata (no text was extracted).',
      `File name: ${input.filename || input.title || 'unknown'}`,
      `MIME type: ${input.mimeType || 'unknown'}`,
      '',
      'Infer, from the name and type alone, what this document most likely is and what it is typically used for.',
      'In `summary` and `purpose`, make clear this is inferred from the file name/type, not the contents.',
      'Keep keyPoints to general guidance about this kind of document. Be concise.',
    ].join('\n');
  }
  return [
    'You are analyzing a business/legal document for a small-business owner so they understand it at a glance.',
    `Document kind (as labeled in the app): ${input.kind}`,
    `Title: ${input.title || '(untitled)'}`,
    '',
    'Document content (markdown):',
    '"""',
    input.body.slice(0, 12_000),
    '"""',
    '',
    'Explain plainly: what this document is, what it is for, and the key points (parties, dates,',
    'amounts, obligations, action items, and any [bracketed] blanks the user still needs to fill in).',
    'Use the reader\'s own context — do not invent facts not present in the text. Be concise and concrete.',
  ].join('\n');
}

/**
 * AI breakdown of a saved document for the read-only view page. Created drafts
 * are analyzed from their full text; binary uploads are analyzed from file
 * metadata only (Phase 1 — no OCR/text extraction yet). Returns null on failure
 * so the caller can show a graceful fallback rather than erroring the page.
 */
export async function analyzeDocument(input: AnalyzeInput): Promise<DocumentBreakdown | null> {
  try {
    const response = await chatCompletion(
      { userId: input.userId, orgId: input.orgId, actor: 'user', feature: 'document-analyze' },
      {
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [{ role: 'user', content: buildPrompt(input) }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'DocumentBreakdown', strict: true, schema: SCHEMA },
        },
      },
    );
    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw) as DocumentBreakdown;
    if (!parsed.documentType || !parsed.summary) return null;
    return parsed;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'document analyze failed');
    return null;
  }
}
