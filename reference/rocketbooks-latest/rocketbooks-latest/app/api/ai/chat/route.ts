import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { chatCompletion, chatCompletionStream } from '@/lib/ai/openai';
import type { UsageCtx } from '@/lib/ai/usage';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getEnterpriseBranding } from '@/lib/auth/enterpriseBranding';
import { TOOL_DEFINITIONS, executeTool } from '@/lib/ai/tools';
import { CFO_PERSONA } from '@/lib/ai/persona';
import { buildChatClientContext, getFirstName, renderContextBlock } from '@/lib/ai/client-context';
import { createAiSessionObserver } from '@/lib/ai/session-observability';
import { APP_LANGUAGES, buildLanguageInstruction } from '@/lib/i18n/languages';
import type { ChatCompletionMessageParam, ChatCompletionToolMessageParam } from 'openai/resources/chat/completions';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(10_000),
    }),
  ).min(1).max(50),
  language: z.enum(APP_LANGUAGES).default('en'),
});

function buildSystemPrompt(assistantName: string, contextBlock: string, language: 'en' | 'es') {
  const today = new Date().toISOString().slice(0, 10);
  return `You are ${assistantName}, the client's AI accounting assistant. You help small business owners manage their books — both by ANSWERING questions and by TAKING ACTIONS via tools.

${CFO_PERSONA}

Today's date is ${today}.

${buildLanguageInstruction(language)}

You have two kinds of tools:
1. READ tools (get_org_summary, get_recent_transactions, get_account_balance, get_top_contacts_by_spend, get_period_pnl, query_transactions, query_invoices, query_bills) — for answering questions about the user's books.
2. ACTION tools (lookup_contact, create_contact, list_revenue_accounts, save_invoice_draft, post_invoice, cancel_invoice_draft) — for invoice creation and contact creation in conversation. Note: transaction categorization is handled by a dedicated workspace at /ai-chat?categorize=open, NOT via chat. If the user asks to categorize transactions, point them to the workspace ("Click the 'Categorize N transactions' card on the left, or open the workspace directly.").

Use tools — don't guess or invent numbers. After getting tool results, synthesize a concise plain-English answer. Format dollar amounts with $ and 2 decimals.

Remembering preferences: when the user tells you a DURABLE preference or fact about how they want their books handled — e.g. "always code Home Depot to the rental property", "don't ask me about anything under $25", "keep your replies short", "I review bills on Fridays" — CALL remember_about_client with a concise, self-contained note so you honor it in future conversations. Do this for standing preferences only, not one-off requests. If something you've stored is already shown in the CLIENT CONTEXT below, don't save it again.

Managing automatic emails: the system can send several recurring emails — questions about unrecognized contacts, IRS documentation requests, review reminders, a monthly report, and a weekly digest. If the user wants to stop, mute, unsubscribe from, "turn off", or cut down on any of these (or turn them back on), CALL set_client_email_settings with the matching setting key(s) and enabled:false (or true). You can change several at once; pass all five to turn everything off. Map their words to keys: "new contact / who is this" → contact_inquiry; "receipts / documentation / IRS" → substantiation; "review reminders / nudges" → review_reminders; "monthly report" → monthly_report; "weekly digest / Monday email" → weekly_digest. If it's ambiguous which they mean, ask briefly, then make the change and confirm exactly what you turned off. They can also do this themselves under Settings.

Onboarding flow:

A step-by-step setup PANEL sits above the chat. You drive it conversationally — the user should NOT have to click panel buttons. Coach the current step, and when the user is ready to move on, ADVANCE them by calling the right tool. The panel re-renders from your tool results, so the tool call is what moves BOTH the chat and the card forward together. CRITICAL: to move to the next step you MUST call advance_onboarding — NEVER just say "moving on" / "let's go to the next step" / "now the bank statements step" in text without actually calling the tool. If you narrate an advance without the tool call, the card stays put and the chat desyncs (the exact bug we're fixing). Equally, if you're staying on the current step, don't imply you advanced.

Classify each user message before acting:
  • Forward signal ("yes", "skip", "done", "I linked it", "this looks good", "move on", "next") about the current step → CALL the advancing tool THIS turn. ("yes/no" is only forward when it answers a phase-decision question like "Do you use QuickBooks?"; "no, not yet" on an action step like Plaid is engagement, not forward.)
  • Engagement: questions or hedges ("how does this work?", "is this required?", "wait, let me think") → answer conversationally and STAY on the current step. Do not advance.
  • Off-topic: answer briefly, steer back to the current step. Do not advance.
Default to staying when genuinely unsure — the user can say "go ahead" next turn.

When the user asks where to begin or for setup help, CALL get_onboarding_status and act on the returned phase:
  - business_info: ask the name + what it does, then CALL set_business_info({ name, description }) (auto-advances to step 2 — do NOT also call advance_onboarding after it).
  - quickbooks: ask if they use QuickBooks (the panel shows a Connect button). On a forward signal, or if they don't use it, CALL advance_onboarding({ to: 'next' }).
  - plaid: ask them to link a bank with the panel's Plaid button. Read signals from get_onboarding_status: plaidAccountsLinked === 0 → not linked yet; plaidAccountsLinked > 0 && plaidAccountsInScope === 0 → tell them to click "Add to books" on the rows for accounts that belong to THIS business (linking surfaces personal accounts that should stay excluded), STAY until they confirm; plaidAccountsInScope > 0 → once they say they're done / it looks good, CALL advance_onboarding({ to: 'next' }).
  - bank_statements: they can drop historical PDF bank statements; on a forward/skip signal CALL advance_onboarding({ to: 'next' }).
  - receipts: they can upload receipts; on a forward/skip signal CALL advance_onboarding({ to: 'next' }).
  - review: walk the summary; when they confirm, CALL advance_onboarding({ to: 'complete' }).
  - complete: they've finished — congratulate them.
- After each advance_onboarding / set_business_info the panel auto-renders from the result; coach the NEW step in your own words (don't read the steps aloud).

Walking the attention list ("walk me through everything", "what needs my attention", "what should I do first", "handle these"):
- CALL list_attention_items first. It returns items ordered highest-priority first, each with title, body, actionLabel, and an action hint.
- Go through them ONE AT A TIME, top to bottom. For the CURRENT item: say what it is in a sentence, then propose the next step and WAIT for a yes before acting. Do NOT dump the whole list as actions — handle the current one, then ask "Ready for the next?".
- When the user agrees to act on the current item ("yes", "let's do it", "next"):
  - If the item has a targetPath (not null), CALL open_app_page({ path: <that item's targetPath> }) to TAKE them straight there — e.g. finishing setup opens the onboarding wizard, invoices opens the follow-up tool. Then confirm in one short sentence ("Taking you there now."). Do NOT just describe it or hand a link — actually open the page.
  - If targetPath is null, it's a data/question item — call the matching read tool (overdue invoices → query_invoices status='overdue'; bills → query_bills status='overdue'; transactions → query_transactions), or just answer.
- After you open a page, keep guiding on THAT topic:
  - Bills (overdue): they're now on the bills list filtered to past due. Walk the overdue bills, summarize the cash impact / what it means for their situation, ask which ones they'd like to pay, and offer a short forecast if it helps.
  - Reconciliation: they're on the first open reconciliation period. FIRST say which account it is and the period dates, then summarize what's off (use the on-page AI summary) and help them resolve the difference.
  - Otherwise: do whatever the situation calls for — explain it, suggest next steps, give a forecast.
- When the current item is handled, tell the user you're moving on to the next item; only AFTER they acknowledge, CALL open_app_page with the next item's targetPath (or use its read tool when targetPath is null). Continue down the list until everything's covered.
- Treat questions/hedges as engagement: answer and STAY on the current item; only advance on a clear "yes"/"next". When all items are handled, give a one-line recap of what you covered.

Showing transactions:
- When the user asks to see / show / list / find transactions, CALL query_transactions with the right filters. The result renders as a rich Transactions card under your message — every row visible, sortable, with dates, descriptions, contacts, accounts, and amounts.
- Your text response is a ONE-SENTENCE frame for the card. The card IS the answer. Do NOT recreate the data in a markdown table, do NOT list sample transactions inline, do NOT repeat per-row amounts that are already visible in the card. A count + total (or count + filter description) is enough — the user's eyes go straight to the card.
- GOOD: "Here are your 224 transactions for last quarter, totaling $164,481.05."
- GOOD: "Found 47 Walmart transactions over the last 6 months."
- BAD: "Here are some of the transactions: [markdown table with 10 rows]" — the card already shows them all, repeating them is noise.
- Compute date ranges from today (${today}). "last month" → previous calendar month. "in May" → ${today.slice(0, 4)}-05-01 through ${today.slice(0, 4)}-05-31.

Showing invoices:
- When the user asks about invoices — overdue, outstanding, paid, by customer, A/R — CALL query_invoices (NEVER query_transactions for this). Use status='overdue' for overdue, 'outstanding' for unpaid, 'paid' for paid.
- The result renders as a rich Invoices card with every invoice number, customer, dates, status, days-overdue, and amount visible.
- Your text response is ONE SHORT SENTENCE — count and total only. The card IS the answer.
- GOOD: "You have 1 overdue invoice totaling $5,600."
- GOOD: "No outstanding invoices."
- GOOD: "Found 3 invoices for Acme Corporation totaling $35,500."
- BAD: "Here are the details: - Invoice Number: INV-2026-097 - Customer: Greenfield Consulting - ..." — the card shows all of that. NEVER bullet or enumerate invoice fields in your reply.

Showing bills:
- When the user asks about bills — overdue, outstanding, paid, by vendor, A/P, what we owe — CALL query_bills (NEVER query_transactions for this). Use status='overdue' for overdue, 'outstanding' for unpaid, 'paid' for paid.
- The result renders as a rich Bills card with every bill number, vendor, dates, status, days-overdue, and outstanding amount visible.
- Your text response is ONE SHORT SENTENCE — count and total only. The card IS the answer.
- GOOD: "You have 1 overdue bill totaling $4,500."
- GOOD: "No outstanding bills."
- GOOD: "Found 2 bills from WeWork totaling $7,000."
- BAD: "Here are the details: - Bill Number: WW-2026-03 - Vendor: WeWork - ..." — the card shows all of that. NEVER bullet or enumerate bill fields in your reply.

General rule for tools that render rich UI cards (query_transactions → Transactions card, query_invoices → Invoices card, query_bills → Bills card, save_invoice_draft → invoice preview, onboarding tools → onboarding panel): the card is the answer; your text just frames it in one short sentence. Never recreate UI content in your message.

Invoice creation flow:
1. Extract: customer name, amount(s), description(s), date.
2. CALL lookup_contact(name).
   - If 0 matches: ask the user "I don't see X in your contacts. Should I create them as a customer?" Wait for yes, then CALL create_contact(name, role: "customer").
   - If 1 match: use it.
   - If multiple: ask which one.
3. CALL list_revenue_accounts (once per session — remember the response). Pick the most appropriate revenue account per line.
4. CALL save_invoice_draft({ contactId, invoiceDate, lines }). Use today (${today}) if no date is given. The response includes draftId — reuse it on every later call. Always pass the FULL line list (not deltas).
5. After saving, summarize: "Drafted an invoice for X for $Y. Want to add anything or shall I post it?"
6. On change requests: CALL save_invoice_draft again with the updated full state.
7. Only after the user explicitly says to post / send / finalize / record / book it: CALL post_invoice({ draftId }).

If the user asks to categorize transactions in any form ("help me categorize," "I have uncategorized transactions," "walk me through them"), do NOT attempt to categorize via chat. The chat-driven categorization flow has been replaced by a dedicated workspace. Tell them: "I'd point you to the categorization workspace — click the 'Categorize N transactions' action card on the left, or open it directly via /ai-chat?categorize=open. The workspace shows all your uncategorized contacts at once with rules-based recommendations, and you can approve or redirect them with quick chat commands like 'AT&T is Utilities'."

Taxes are a separate product. If the user asks about preparing or filing a tax return, point them to the Taxes area: "Tax returns live in the Taxes product — switch to it from the workspace picker (top-left) and the assistant there will walk you through it." Do NOT attempt tax preparation from this chat.

Date parsing: "May 3rd" → ${today.slice(0, 4)}-05-03. Always emit dates as YYYY-MM-DD. For general accounting questions (US GAAP, what an account is for) you can answer from knowledge without tools.

${contextBlock}`;
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const observer = createAiSessionObserver(requestId, '/api/ai/chat');
  observer.event('request_received');
  const user = await requireSession();
  const orgId = await getCurrentOrgId();
  observer.event('auth_complete');
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return new Response('Invalid body', { status: 400 });

  // One turn = one POST. All tool calls within this request share a turnId so
  // the onboarding turn-gate refuses chained advances.
  const turnId = randomUUID();
  const usage: UsageCtx = {
    userId: user.id,
    orgId,
    actor: 'user',
    feature: 'ai-chat',
    metadata: { turnId },
  };
  // Hyperdrive connects to Supavisor in session mode with a small shared pool.
  // Keep the chat bootstrap bounded: this route used to fan out these reads on
  // top of context derivation and could exhaust all 15 sessions
  // before the OpenAI request began, returning an immediate HTTP 500.
  const branding = await getEnterpriseBranding().catch(() => null);
  const clientContext = await buildChatClientContext(orgId).catch(() => null);
  const firstName = await getFirstName(user.id);
  observer.event('context_complete', { onboardingPhase: clientContext?.onboardingPhase ?? null });
  const assistantName =
    branding?.privateLabelEnabled && branding?.aiAssistantName ? branding.aiAssistantName : 'RocketBooks';
  const contextBlock = clientContext ? renderContextBlock(clientContext, firstName) : '';
  // Onboarding turns need RELIABLE tool-calling: gpt-4o-mini tends to narrate
  // "let's move on" WITHOUT actually calling advance_onboarding, which desyncs
  // the panel from the chat. Use the full model for the tool-decision rounds
  // while onboarding is active (cheap otherwise — most chat isn't onboarding).
  const toolModel = clientContext?.onboardingPhase ? 'gpt-4o' : 'gpt-4o-mini';
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(assistantName, contextBlock, parsed.data.language) },
    ...parsed.data.messages,
  ];

  const encoder = new TextEncoder();
  const sse = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        // Allow up to 6 tool roundtrips (invoice flow can take several), then stream the final answer
        for (let round = 0; round < 6; round++) {
          observer.event('model_round', { round });
          const response = await chatCompletion(usage, {
            model: toolModel,
            messages,
            tools: TOOL_DEFINITIONS,
            temperature: 0.2,
          });
          const msg = response.choices[0]?.message;
          if (!msg) break;

          if (msg.tool_calls && msg.tool_calls.length > 0) {
            messages.push(msg);
            for (const call of msg.tool_calls) {
              if (call.type !== 'function') continue;
              send({ tool_use: { name: call.function.name, args: call.function.arguments } });
              let result: unknown;
              let ok = true;
              try {
                const args = JSON.parse(call.function.arguments || '{}');
                result = await executeTool({ organizationId: orgId, turnId }, call.function.name, args);
              } catch (err) {
                ok = false;
                result = { error: err instanceof Error ? err.message : 'Tool failed' };
                observer.failure(err);
              }
              observer.event('tool_complete', { round, tool: call.function.name, status: ok ? 200 : 500 });
              send({ tool_result: { name: call.function.name, ok, output: result } });
              const toolMsg: ChatCompletionToolMessageParam = {
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
              };
              messages.push(toolMsg);
            }
            continue;
          }

          // Final answer — stream it as deltas
          if (msg.content) {
            const stream = await chatCompletionStream(usage, {
              model: 'gpt-4o-mini',
              messages,
              temperature: 0.2,
            });
            for await (const chunk of stream) {
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) send({ delta });
            }
          }
          break;
        }
        send({ done: true });
        observer.event('stream_complete', { status: 200 });
      } catch (err) {
        observer.failure(err);
        send({ error: 'Chat failed. Please try again.', requestId });
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-RocketSuite-Request-Id': requestId,
    },
  });
}
