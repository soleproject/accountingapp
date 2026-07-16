import 'server-only';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { chartOfAccounts } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';
import { logger } from '@/lib/logger';

interface LineInput {
  description: string;
  amount: number;
}

interface Suggestion {
  lineIndex: number;
  accountId: string | null;
}

/**
 * For each line, ask gpt-4o-mini to pick the best matching expense
 * account from the org's CoA. Returns one suggestion per line in input
 * order. `accountId === null` means the model declined to pick (we
 * surface that to the user as "no suggestion" rather than guessing).
 *
 * Failures (no API key, malformed JSON, network) are logged and return
 * all-null — the receipt still saves; the user just categorizes manually.
 */
export async function suggestLineAccounts(
  orgId: string,
  vendorName: string | null,
  lines: LineInput[],
  ctx: { userId: string | null } = { userId: null },
): Promise<Suggestion[]> {
  if (lines.length === 0) return [];

  // Restrict candidates to expense-style accounts. The CoA stores GAAP
  // type as free-form text; the values that actually appear for expenses
  // in this codebase are 'expense' and 'cost_of_goods_sold' (see
  // chart-of-accounts seed). Keep the list short — fewer candidates =
  // higher pick accuracy and lower token spend.
  const expenseAccounts = await db
    .select({
      id: chartOfAccounts.id,
      accountName: chartOfAccounts.accountName,
      accountNumber: chartOfAccounts.accountNumber,
      detailType: chartOfAccounts.detailType,
      definition: chartOfAccounts.definition,
    })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.isActive, true),
        inArray(chartOfAccounts.gaapType, ['expense', 'cost_of_goods_sold']),
      ),
    );

  if (expenseAccounts.length === 0) {
    logger.info({ orgId }, 'suggestLineAccounts: no expense accounts in org CoA');
    return lines.map((_, i) => ({ lineIndex: i, accountId: null }));
  }

  const accountList = expenseAccounts
    .map(
      (a) =>
        `- ${a.id} | ${a.accountNumber} ${a.accountName}${a.detailType ? ` (${a.detailType})` : ''}${a.definition ? ` — ${a.definition}` : ''}`,
    )
    .join('\n');

  const lineList = lines
    .map((l, i) => `${i}. ${l.description} ($${l.amount.toFixed(2)})`)
    .join('\n');

  const prompt = `Categorize each receipt line below to ONE account from the chart of accounts.

Vendor: ${vendorName ?? 'unknown'}

Chart of Accounts (id | number name (detail_type) — definition):
${accountList}

Lines:
${lineList}

For each line, return the EXACT account id (the UUID before the |) that best matches the line description. If no account is a reasonable match, return null for that line.`;

  let raw: string;
  try {
    const response = await chatCompletion(
      { userId: ctx.userId, orgId, actor: 'user', feature: 'receipt-line-categorize' },
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'ReceiptLineSuggestions',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['suggestions'],
              properties: {
                suggestions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['lineIndex', 'accountId'],
                    properties: {
                      lineIndex: { type: 'integer' },
                      accountId: { type: ['string', 'null'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    );
    raw = response.choices[0]?.message?.content ?? '';
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, orgId },
      'suggestLineAccounts: openai call failed',
    );
    return lines.map((_, i) => ({ lineIndex: i, accountId: null }));
  }

  let parsed: { suggestions: Suggestion[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, raw }, 'suggestLineAccounts: malformed JSON');
    return lines.map((_, i) => ({ lineIndex: i, accountId: null }));
  }

  // gpt-4o-mini sometimes ignores "return the UUID" and returns the
  // account_number (e.g. "5000") or the account name. Three rounds of
  // prompt tightening didn't fix it for this call site — follow
  // lib/accounting/resolve-account.ts's lead and accept any of UUID /
  // account_number / case-insensitive account_name.
  const byUuid = new Map<string, string>();
  const byNumber = new Map<string, string>();
  const byNameLower = new Map<string, string>();
  for (const a of expenseAccounts) {
    byUuid.set(a.id, a.id);
    if (a.accountNumber) byNumber.set(a.accountNumber, a.id);
    byNameLower.set(a.accountName.toLowerCase(), a.id);
  }
  const resolveCandidate = (raw: string | null): string | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return byUuid.get(trimmed) ?? byNumber.get(trimmed) ?? byNameLower.get(trimmed.toLowerCase()) ?? null;
  };
  const byIndex = new Map<number, string | null>();
  for (const s of parsed.suggestions ?? []) {
    if (typeof s.lineIndex !== 'number') continue;
    byIndex.set(s.lineIndex, resolveCandidate(s.accountId));
  }

  return lines.map((_, i) => ({ lineIndex: i, accountId: byIndex.get(i) ?? null }));
}
