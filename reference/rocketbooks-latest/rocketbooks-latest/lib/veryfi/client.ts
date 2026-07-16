import 'server-only';

export interface VeryfiResult {
  id: number;
  vendor?: { name?: string; raw_name?: string; logo?: string };
  total?: number;
  date?: string;
  category?: string;
  notes?: string;
  line_items?: Array<{ description?: string; total?: number }>;
  ocr_text?: string;
}

export class VeryfiError extends Error {}

export async function veryfiProcessDocument(buffer: Buffer, filename: string): Promise<VeryfiResult> {
  const clientId = process.env.VERYFI_CLIENT_ID;
  const username = process.env.VERYFI_USERNAME;
  const apiKey = process.env.VERYFI_API_KEY;
  if (!clientId || !username || !apiKey) {
    throw new VeryfiError('Veryfi credentials not configured (VERYFI_CLIENT_ID, VERYFI_USERNAME, VERYFI_API_KEY)');
  }

  const fileB64 = buffer.toString('base64');
  const res = await fetch('https://api.veryfi.com/api/v8/partner/documents/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CLIENT-ID': clientId,
      AUTHORIZATION: `apikey ${username}:${apiKey}`,
    },
    body: JSON.stringify({
      file_name: filename,
      file_data: fileB64,
      categories: ['Meals & Entertainment', 'Travel', 'Office Supplies', 'Software', 'Equipment', 'Other'],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new VeryfiError(`Veryfi API ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as VeryfiResult;
}
