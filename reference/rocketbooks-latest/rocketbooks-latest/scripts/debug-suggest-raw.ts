import { config } from 'dotenv';
import { eq, and, inArray } from 'drizzle-orm';
config({ path: '.env.local' });
async function main() {
  const { db } = await import('../db/client');
  const { chartOfAccounts, organizations, receipts, receiptLines, contacts } = await import('../db/schema/schema');
  const { chatCompletion } = await import('../lib/ai/openai');
  const { desc } = await import('drizzle-orm');

  const [acme] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, 'Acme Corp')).limit(1);
  if (!acme) process.exit(0);

  const [r] = await db.select({ id: receipts.id, contactId: receipts.contactId, vendor: contacts.contactName }).from(receipts).leftJoin(contacts, eq(receipts.contactId, contacts.id)).where(eq(receipts.organizationId, acme.id)).orderBy(desc(receipts.id)).limit(1);
  if (!r) process.exit(0);

  const lines = await db.select({ id: receiptLines.id, desc: receiptLines.description, amt: receiptLines.amount }).from(receiptLines).where(eq(receiptLines.receiptId, r.id));

  const accts = await db.select({ id: chartOfAccounts.id, num: chartOfAccounts.accountNumber, name: chartOfAccounts.accountName, type: chartOfAccounts.gaapType, det: chartOfAccounts.detailType, defn: chartOfAccounts.definition }).from(chartOfAccounts).where(and(eq(chartOfAccounts.organizationId, acme.id), eq(chartOfAccounts.isActive, true), inArray(chartOfAccounts.gaapType, ['expense', 'cost_of_goods_sold'])));
  console.log(`Candidate accounts: ${accts.length}`);

  const list = accts.map((a) => `- ${a.id} | ${a.num} ${a.name}${a.det ? ` (${a.det})` : ''}${a.defn ? ` — ${a.defn}` : ''}`).join('\n');
  const lineList = lines.map((l, i) => `${i}. ${l.desc} ($${Number(l.amt).toFixed(2)})`).join('\n');
  const prompt = `Categorize each receipt line below to ONE account from the chart of accounts.\n\nVendor: ${r.vendor ?? 'unknown'}\n\nChart of Accounts (id | number name (detail_type) — definition):\n${list}\n\nLines:\n${lineList}\n\nFor each line, return the EXACT account id (the UUID before the |) that best matches the line description. If no account is a reasonable match, return null for that line.`;

  const response = await chatCompletion(
    { userId: null, orgId: acme.id, actor: 'user', feature: 'receipt-line-categorize-debug' },
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
  console.log('\nRAW OpenAI response:');
  console.log(response.choices[0]?.message?.content);
  process.exit(0);
}
main().catch(console.error);
