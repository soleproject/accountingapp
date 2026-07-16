import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const invoiceActions = readFileSync('app/(app)/invoices/_components/InvoiceRowActions.tsx', 'utf8');
const billActions = readFileSync('app/(app)/bills/_components/BillRowActions.tsx', 'utf8');
const contactActions = readFileSync('app/(app)/contacts/_components/RowActions.tsx', 'utf8');

const invoiceClient = readFileSync('app/(app)/invoices/_components/InvoicesClient.tsx', 'utf8');
const billsClient = readFileSync('app/(app)/bills/_components/BillsClient.tsx', 'utf8');
const journalClient = readFileSync('app/(app)/journal-entries/_components/JournalEntriesClient.tsx', 'utf8');
const contactsClient = readFileSync('app/(app)/contacts/_components/ContactsLoaded.tsx', 'utf8');

assert.match(invoiceClient, /href=\{`\/invoices\/\$\{i\.id\}`\}[\s\S]*prefetch=\{false\}/, 'invoice detail links must disable prefetch');
assert.match(invoiceClient, /href=\{`\/journal-entries\/\$\{i\.journalEntryId\}`\}[\s\S]*prefetch=\{false\}/, 'invoice journal-entry links must disable prefetch');
assert.match(billsClient, /href=\{`\/bills\/\$\{b\.id\}`\}[\s\S]*prefetch=\{false\}/, 'bill detail links must disable prefetch');
assert.match(billsClient, /href=\{isActive \? '\/bills' : `\/bills\?filter=\$\{filter\}`\}[\s\S]*prefetch=\{false\}/, 'bill filter cards must disable prefetch');
assert.match(journalClient, /href=\{`\/journal-entries\/\$\{e\.jeId\}`\}[\s\S]*prefetch=\{false\}/, 'journal-entry detail links must disable prefetch');
assert.match(journalClient, /href=\{docHref\}[\s\S]*prefetch=\{false\}/, 'journal-entry source document links must disable prefetch');
assert.match(contactsClient, /href=\{buildHref\(\{ status: s, page: 1 \}\)\}[\s\S]*prefetch=\{false\}/, 'contacts status filters must disable prefetch');

assert.match(invoiceActions, /href=\{`\/invoices\/\$\{invoiceId\}\/edit`\}[\s\S]*prefetch=\{false\}/, 'invoice row edit actions must disable prefetch fanout');
assert.match(billActions, /href=\{`\/bills\/\$\{billId\}\/edit`\}[\s\S]*prefetch=\{false\}/, 'bill row edit actions must disable prefetch fanout');
assert.match(contactActions, /href=\{`\/contacts\/\$\{id\}`\}[\s\S]*prefetch=\{false\}/, 'contact row edit actions must disable prefetch fanout');

console.log('list-prefetch-fanout: high-fanout launch list pages disable non-critical RSC prefetch');
