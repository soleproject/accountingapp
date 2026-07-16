'use server';

import { z } from 'zod';
import { getOpenAI } from '@/lib/ai/openai';
import { recordServiceUsage } from '@/lib/ai/usage';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { uploadDeckImage } from '@/lib/storage/deck-images';

export interface GeneratedImage {
  prompt: string;
  /** Public Storage URL for the image, or null if it couldn't be produced. */
  url: string | null;
}

const Schema = z.object({
  prompts: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
  source: z.enum(['ai', 'stock']).default('ai'),
  quality: z.enum(['low', 'medium', 'high']).default('low'),
});

/** AI-generate one image (gpt-image-1) and return raw PNG bytes, or null. */
async function aiImage(prompt: string, quality: 'low' | 'medium' | 'high'): Promise<{ bytes: Buffer; type: string } | null> {
  const res = await getOpenAI().images.generate({
    model: 'gpt-image-1',
    prompt: `Clean, professional presentation illustration, landscape, no text or words in the image: ${prompt}`,
    size: '1536x1024',
    quality,
    n: 1,
  });
  const b64 = res.data?.[0]?.b64_json;
  return b64 ? { bytes: Buffer.from(b64, 'base64'), type: 'image/png' } : null;
}

const STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'and', 'to', 'for', 'with', 'against', 'at', 'their', 'they',
  'this', 'that', 'is', 'are', 'by', 'from', 'as', 'into', 'over', 'no', 'text', 'image', 'illustration',
  'photo', 'picture', 'showing', 'clean', 'professional', 'presentation', 'landscape', 'across', 'view',
]);

/** Descriptive img: prompts are written for AI gen and make poor keyword
 *  searches. Reduce to meaningful keywords for stock lookup. */
function keywords(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Find a free, commercially-usable (CC0 / public-domain) stock photo via
 *  Openverse and return its bytes — no API key, no attribution required. The
 *  CC0 corpus is sparse for specific phrases, so progressively simplify the
 *  query (3 → 2 → 1 keywords) until something matches. */
async function stockImage(prompt: string): Promise<{ bytes: Buffer; type: string } | null> {
  const kw = keywords(prompt);
  const queries = [...new Set([kw.slice(0, 3).join(' '), kw.slice(0, 2).join(' '), kw[0]])].filter(Boolean);

  let imgUrl: string | undefined;
  for (const q of queries) {
    const res = await fetch(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm&page_size=1&mature=false`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) continue;
    const json = (await res.json()) as { results?: Array<{ url?: string }> };
    if (json.results?.[0]?.url) {
      imgUrl = json.results[0].url;
      break;
    }
  }
  if (!imgUrl) return null;

  const img = await fetch(imgUrl);
  if (!img.ok) return null;
  const type = (img.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\/(png|jpeg|webp)$/.test(type)) return null;
  return { bytes: Buffer.from(await img.arrayBuffer()), type };
}

/**
 * Produce one image per prompt for a slide deck and return its persisted URL so
 * the client can write it into the deck body (`imgsrc:`). Source 'ai' uses
 * gpt-image-1 (quality defaults to low — cheapest); 'stock' pulls a free CC0 /
 * public-domain photo from Openverse (no per-image cost). Both re-host to our
 * public bucket so they persist + reload. Capped at 12; best-effort per prompt.
 */
export async function generateDeckImagesAction(input: unknown): Promise<GeneratedImage[]> {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return [];
  const { prompts, source, quality } = parsed.data;

  return Promise.all(
    prompts.map(async (prompt): Promise<GeneratedImage> => {
      try {
        const img = source === 'stock' ? await stockImage(prompt) : await aiImage(prompt, quality);
        if (!img) return { prompt, url: null };
        // Stock images are free (Openverse CC0); only AI-generated images bill.
        if (source === 'ai') {
          recordServiceUsage(
            { userId: user.id, orgId, actor: 'user', feature: 'deck-image-gen' },
            { provider: 'openai', category: 'image', unit: 'images', quantity: 1, rateKey: `openai-image:${quality}`, model: 'gpt-image-1' },
          );
        }
        const url = await uploadDeckImage(orgId, img.bytes, img.type);
        return { prompt, url };
      } catch {
        return { prompt, url: null };
      }
    }),
  );
}
