import 'server-only';

export interface VeryfiBankStatementTransaction {
  order?: number;
  date?: string;
  posted_date?: string;
  description?: string;
  text?: string;
  debit_amount?: number;
  credit_amount?: number;
  balance?: number;
  category?: string;
  vendor?: { name?: string; raw_name?: string };
  transaction_id?: string;
  card_number?: string;
}

export interface VeryfiBankStatementAccount {
  account_number?: string;
  account_type?: string;
  starting_balance?: number;
  ending_balance?: number;
  transactions?: VeryfiBankStatementTransaction[];
}

export interface VeryfiBankStatement {
  id: number;
  bank_name?: string;
  account_number?: string;
  starting_balance?: number;
  ending_balance?: number;
  period_start_date?: string;
  period_end_date?: string;
  statement_date?: string;
  accounts?: VeryfiBankStatementAccount[];
  // The raw response is opaque — we only typed the fields we use
  [key: string]: unknown;
}

/** Normalized transaction the rest of the app sees, regardless of how Veryfi nests them. */
export interface NormalizedBankTxn {
  date: string | null;
  description: string;
  type: 'debit' | 'credit' | null;
  amount: number; // positive
  balance: number | null;
  reference: string | null;
  category: string | null;
  vendorName: string | null;
}

export class VeryfiError extends Error {}

function authHeaders(): Record<string, string> {
  const clientId = process.env.VERYFI_CLIENT_ID;
  const username = process.env.VERYFI_USERNAME;
  const apiKey = process.env.VERYFI_API_KEY;
  if (!clientId || !username || !apiKey) {
    throw new VeryfiError('Veryfi credentials not configured (VERYFI_CLIENT_ID, VERYFI_USERNAME, VERYFI_API_KEY)');
  }
  return {
    'Content-Type': 'application/json',
    'CLIENT-ID': clientId,
    AUTHORIZATION: `apikey ${username}:${apiKey}`,
  };
}

export interface ProcessBankStatementOptions {
  timeoutMs?: number;
  /**
   * Custom category labels Veryfi will use to classify each transaction.
   * Per the Veryfi docs, when supplied these REPLACE the default categories
   * — Veryfi's ML maps each line to whichever label best fits. We pass our
   * org's chart-of-accounts names so the response comes back already
   * mapped to canonical buckets, no separate Veryfi→CoA table needed.
   *
   * Caveat: too many categories can dilute matching accuracy. Aim for
   * ~20-40 well-named buckets.
   */
  categories?: string[];
}

/**
 * Process a bank statement synchronously. Veryfi's bank-statements endpoint
 * blocks until extraction is complete (~30-60s typical). NO trailing slash —
 * that triggers a redirect that some clients drop the auth header on.
 */
export async function processBankStatementSync(
  buffer: Buffer,
  filename: string,
  options: ProcessBankStatementOptions = {},
): Promise<VeryfiBankStatement> {
  const timeoutMs = options.timeoutMs ?? 110_000;
  const fileB64 = buffer.toString('base64');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.veryfi.com/api/v8/partner/bank-statements', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        file_name: filename,
        file_data: fileB64,
        max_pages_to_process: 50,
        bounding_boxes: false,
        confidence_details: false,
        ...(options.categories && options.categories.length > 0
          ? { categories: options.categories }
          : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new VeryfiError(`Veryfi ${res.status}: ${text.slice(0, 240)}`);
    }
    return (await res.json()) as VeryfiBankStatement;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new VeryfiError(`Veryfi request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Flatten Veryfi's accounts[] → transactions[] structure into a single
 * normalized list. Most statements have one account; multi-account
 * statements just concatenate.
 */
export function normalizeTransactions(doc: VeryfiBankStatement): NormalizedBankTxn[] {
  const out: NormalizedBankTxn[] = [];
  const accounts = Array.isArray(doc.accounts) ? doc.accounts : [];
  for (const acct of accounts) {
    const txns = Array.isArray(acct.transactions) ? acct.transactions : [];
    for (const t of txns) {
      const debit = typeof t.debit_amount === 'number' ? t.debit_amount : 0;
      const credit = typeof t.credit_amount === 'number' ? t.credit_amount : 0;
      let type: 'debit' | 'credit' | null = null;
      let amount = 0;
      if (debit > 0) {
        type = 'debit';
        amount = debit;
      } else if (credit > 0) {
        type = 'credit';
        amount = credit;
      } else if (debit < 0) {
        type = 'credit';
        amount = -debit;
      } else if (credit < 0) {
        type = 'debit';
        amount = -credit;
      }
      out.push({
        date: t.date ?? t.posted_date ?? null,
        description: t.description ?? t.text ?? '',
        type,
        amount,
        balance: typeof t.balance === 'number' ? t.balance : null,
        reference: t.transaction_id ?? null,
        category: t.category ?? null,
        vendorName: t.vendor?.name ?? t.vendor?.raw_name ?? null,
      });
    }
  }
  return out;
}
