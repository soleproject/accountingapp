'use server';

import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { chatCompletion } from '@/lib/ai/openai';
import type { BulkImportRow } from './bulkImportClients';

/**
 * Extract client rows (name / email / company) from an image — a photo or
 * screenshot of a client list, spreadsheet, or business cards — using the
 * vision model. Results land in the editable import preview, so the firm
 * confirms/fixes them before anything is imported.
 */
export async function extractClientsFromImageAction(
  dataUrl: string,
): Promise<{ rows: BulkImportRow[]; error?: string }> {
  const sessionUser = await requireSession();
  const current = await getCurrentEnterprise();
  if (!current) return { rows: [], error: 'No active enterprise.' };
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
    return { rows: [], error: 'Please upload a PNG, JPG, or WEBP image.' };
  }

  try {
    const res = await chatCompletion(
      { userId: sessionUser.id, orgId: current.id, actor: 'enterprise', feature: 'enterprise-client-extract' },
      {
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You extract client contact rows from an image of a list, spreadsheet, or business cards. Return ONLY JSON.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Extract every distinct client/person in this image. Return JSON of the form ' +
                  '{"clients":[{"fullName":"","email":"","companyName":""}]}. Use an empty string when a ' +
                  'field is not present. Never invent or guess email addresses — only include emails ' +
                  'actually shown. Skip header rows and totals.',
              },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
      },
    );

    const content = res.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content) as {
      clients?: Array<{ fullName?: string; email?: string; companyName?: string }>;
    };
    const rows: BulkImportRow[] = (parsed.clients ?? [])
      .map((c) => ({
        fullName: (c.fullName ?? '').trim(),
        email: (c.email ?? '').trim(),
        companyName: (c.companyName ?? '').trim() || undefined,
      }))
      .filter((c) => c.fullName || c.email);
    return { rows };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'Could not read that image.' };
  }
}
