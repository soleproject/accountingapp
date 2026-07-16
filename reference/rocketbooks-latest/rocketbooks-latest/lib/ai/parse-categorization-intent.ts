import 'server-only';
import { chatCompletion } from './openai';
import { logger } from '@/lib/logger';

/**
 * Single-shot intent parser. Given a free-form user message and the live
 * session state, returns a structured list of actions for the server to
 * execute deterministically. The AI's role is narrow: parse → return
 * structured JSON. It never holds UUIDs across turns, never manages
 * conversation state, never executes anything.
 *
 * Hard constraints enforced post-parse on the server:
 *   - Each action's targetSessionContactId must exist in the provided session.
 *   - Each accountIdHint must resolve via lib/accounting/resolve-account.
 *   - createNewAccount.gaapType must be canonical.
 * If validation fails, the server treats that action as failed and surfaces
 * the row error in the response — the AI doesn't get a re-try loop.
 */

export type IntentAction =
  | {
      kind: 'categorize';
      sessionContactId: string;
      contactNameMatched: string;
      accountIdHint: string; // UUID, account number, or exact name — server resolves
      accountLabelMatched: string;
    }
  | {
      kind: 'propose-categorize';
      sessionContactId: string;
      contactNameMatched: string;
      proposedAccountId: string; // UUID from availableAccounts — server validates
      proposedAccountLabel: string; // "<number> · <name>"
      rationale: string; // why this category fits, in plain English
    }
  | {
      kind: 'confirm-pending';
    }
  | {
      kind: 'skip';
      sessionContactId: string;
      contactNameMatched: string;
    }
  | {
      kind: 'create-account-and-categorize';
      sessionContactId: string;
      contactNameMatched: string;
      proposed: {
        accountName: string;
        accountNumber: string;
        gaapType: string;
        description: string;
      };
    }
  | {
      kind: 'show-remaining';
    }
  | {
      kind: 'session-complete';
    };

export type IntentParseResult =
  | {
      kind: 'actions';
      actions: IntentAction[];
      narration: string;
    }
  | {
      kind: 'unclear';
      clarifyingQuestion: string;
    };

interface ParseInput {
  userMessage: string;
  pendingContacts: Array<{
    sessionContactId: string;
    contactName: string;
    transactionCount: number;
    totalAmount: number;
    recommendationLabel: string | null;
    recommendedAccountId: string | null;
  }>;
  availableAccounts: Array<{
    id: string;
    accountNumber: string;
    accountName: string;
    gaapType: string;
  }>;
  /**
   * Pending proposals the user might be confirming. When set, "yes" / "ok" /
   * "confirm" type inputs map to a confirm-pending action.
   */
  pendingProposalSummary: Array<{
    sessionContactId: string;
    contactName: string;
    proposedAccountLabel: string;
  }>;
  /**
   * When the workspace is in focus mode for a specific contact, this is the
   * sessionContactId of the focused row. The parser interprets the user's
   * message as being about this contact unless they explicitly name a
   * different one.
   */
  focusedContactId: string | null;
  /** For ai_usage_events attribution. */
  organizationId?: string | null;
  actorUserId?: string | null;
}

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['actions', 'unclear'] },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            enum: [
              'categorize',
              'propose-categorize',
              'confirm-pending',
              'skip',
              'create-account-and-categorize',
              'show-remaining',
              'session-complete',
            ],
          },
          sessionContactId: { type: ['string', 'null'] },
          contactNameMatched: { type: ['string', 'null'] },
          accountIdHint: { type: ['string', 'null'] },
          accountLabelMatched: { type: ['string', 'null'] },
          proposedAccountId: { type: ['string', 'null'] },
          proposedAccountLabel: { type: ['string', 'null'] },
          rationale: { type: ['string', 'null'] },
          proposed: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              accountName: { type: 'string' },
              accountNumber: { type: 'string' },
              gaapType: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['accountName', 'accountNumber', 'gaapType', 'description'],
          },
        },
        required: [
          'kind',
          'sessionContactId',
          'contactNameMatched',
          'accountIdHint',
          'accountLabelMatched',
          'proposedAccountId',
          'proposedAccountLabel',
          'rationale',
          'proposed',
        ],
      },
    },
    narration: { type: ['string', 'null'] },
    clarifyingQuestion: { type: ['string', 'null'] },
  },
  required: ['kind', 'actions', 'narration', 'clarifyingQuestion'],
} as const;

function buildPrompt(input: ParseInput): string {
  const contactsList = input.pendingContacts
    .map(
      (c) =>
        `  - ${c.sessionContactId} | "${c.contactName}" | ${c.transactionCount} txns | $${c.totalAmount.toFixed(2)} | rec: ${c.recommendationLabel ?? '(none)'}${c.recommendedAccountId ? ` | recAccountId: ${c.recommendedAccountId}` : ''}`,
    )
    .join('\n');

  const accountsList = input.availableAccounts
    .map((a) => `  - ${a.id} | ${a.accountNumber} · ${a.accountName} (${a.gaapType})`)
    .join('\n');

  const pendingProposalsList = input.pendingProposalSummary
    .map((p) => `  - "${p.contactName}" → ${p.proposedAccountLabel}`)
    .join('\n');

  const focusedContact = input.focusedContactId
    ? input.pendingContacts.find((c) => c.sessionContactId === input.focusedContactId)
    : null;
  const focusBlock = focusedContact
    ? `FOCUS MODE — workspace is auto-walking the user through this contact:
  - sessionContactId: ${focusedContact.sessionContactId}
  - name: "${focusedContact.contactName}"
  - ${focusedContact.transactionCount} txns · $${focusedContact.totalAmount.toFixed(2)}
  - rec: ${focusedContact.recommendationLabel ?? '(none)'}${focusedContact.recommendedAccountId ? ` (recAccountId: ${focusedContact.recommendedAccountId})` : ''}

Default contactId/contactNameMatched to the focused contact unless the user EXPLICITLY names another contact in PENDING.

CONFIRM-FOCUSED rule (very important for v2 walkthrough):
  When the user says a bare affirmative — "yes", "ok", "looks good", "confirm",
  "do it", "go ahead", "perfect", "yep" — and PENDING PROPOSALS is empty AND
  the focused contact has a recAccountId, emit ONE categorize action for the
  focused contact:
    sessionContactId: <focused sessionContactId>
    contactNameMatched: "<focused name>"
    accountIdHint: <focused recAccountId>
    accountLabelMatched: "<focused recommendationLabel>"
  This is how the user approves the engine's proposal for the focused contact.

  If PENDING PROPOSALS is non-empty, the existing confirm-pending rule wins.
  If the focused contact has no recAccountId, return kind: "unclear" with a
  clarifyingQuestion asking which account to use.

Even short messages like "use 2510 instead" or "actually call it Notes Payable"
refer to this focused contact.`
    : 'FOCUS MODE: not active.';

  return `You parse a user's natural-language statement about categorizing transactions into a list of structured actions. You DO NOT execute anything. The server executes whatever you return.

User message: "${input.userMessage}"

${focusBlock}

PENDING contacts in this session (sessionContactId | name | txns | total | rule recommendation):
${contactsList || '  (none — session has no pending contacts)'}

AVAILABLE chart-of-accounts entries in this org (id | number · name · gaapType):
${accountsList || '  (no accounts)'}

PENDING PROPOSALS awaiting user confirmation:
${pendingProposalsList || '  (none)'}

Return JSON with shape:
- { kind: "actions", actions: [...], narration: "<short status sentence>", clarifyingQuestion: null }
  OR
- { kind: "unclear", actions: [], narration: null, clarifyingQuestion: "<one question that disambiguates>" }

Each action is one of:

  { kind: "categorize", sessionContactId, contactNameMatched, accountIdHint, accountLabelMatched, proposedAccountId: null, proposedAccountLabel: null, rationale: null, proposed: null }
    - EXPLICIT account match. Use when the user names an account that IS in AVAILABLE (or close — e.g. "Utilities", "Office Supplies", "Meals & Entertainment").
    - sessionContactId: from PENDING. accountIdHint: the account's UUID from AVAILABLE.
    - Examples: "AT&T is Utilities" / "VCA → Veterinary Expenses" / "put Walmart under Office Supplies".
    - APPROVE/ACCEPT a contact's existing recommendation also uses categorize. When the user names a contact (or several) with verbs like "approve", "accept", "go ahead with", "let's approve", "OK to" — emit one categorize per named contact, using that contact's recAccountId from PENDING as accountIdHint, and the recommendationLabel as accountLabelMatched.
      • "approve Wendy's" → categorize Wendy's with its recAccountId.
      • "let's approve Starbucks, McDonald's, Wendy's" → 3 categorize actions, one per contact, each using its own recAccountId.
      • "go ahead with Pizza Hut and Panera" → 2 categorize actions.
    - If the named contact has NO recommendation (recAccountId missing), do NOT emit categorize — return kind: "unclear" with a clarifyingQuestion asking which account the user wants for that contact.

  { kind: "propose-categorize", sessionContactId, contactNameMatched, accountIdHint: null, accountLabelMatched: null, proposedAccountId, proposedAccountLabel, rationale, proposed: null }
    - INFERRED match. Use when the user describes the NATURE of the transaction without naming an account ("we ate there", "that's our internet", "stocked up for the office", "that's our mortgage").
    - Pick the best-matching EXISTING account from AVAILABLE based on the implicit signal.
    - rationale: short plain-English why ("ate there suggests a business meal", "described as the company internet provider", "implied as a mortgage liability").
    - proposedAccountId: UUID from AVAILABLE. proposedAccountLabel: "<number> · <name>".
    - The server will NOT execute — it shows your proposal in chat and waits for the user to confirm.
    - Examples:
      • "Einstein Bagels we ate there" → propose-categorize with the existing Meals & Entertainment account.
      • "Mr Cooper, that's our mortgage" → propose-categorize with the existing Mortgage Liability account.
      • "Office Depot, those are office supplies" → propose-categorize with the existing Office Supplies account.
      • "company van fuel" → propose-categorize with the existing Auto & Vehicle account.

  { kind: "confirm-pending", sessionContactId: null, contactNameMatched: null, accountIdHint: null, accountLabelMatched: null, proposedAccountId: null, proposedAccountLabel: null, rationale: null, proposed: null }
    - Use ONLY when (a) there are PENDING PROPOSALS listed below AND (b) the user's message is a bare affirmative with NO contact named ("yes", "confirm", "do it", "go ahead", "looks good", "apply", "yep").
    - If the user names one or more contacts (e.g. "approve Wendy's", "accept Starbucks and McDonald's"), do NOT emit confirm-pending — emit categorize per the APPROVE/ACCEPT rule above.
    - If the user says a bare "yes" / "confirm" but PENDING PROPOSALS is empty, do NOT emit confirm-pending — return kind: "unclear" with a clarifyingQuestion like "I don't have anything pending to confirm — try naming a contact and a category."

  { kind: "skip", sessionContactId, contactNameMatched, ... }
    - User says skip / leave / not now for a contact.

  { kind: "create-account-and-categorize", sessionContactId, contactNameMatched, ..., proposed: { accountName, accountNumber, gaapType, description } }
    - IMMEDIATE create. Use ONLY when the user EXPLICITLY says to create — wording like "create X account for Y", "make a new X for Y", "set up Y as a new X". Server creates the account and categorizes in one shot, no confirm step.
    - gaapType MUST be one of: asset, current_asset, fixed_asset, other_asset, liability, current_liability, long_term_liability, other_liability, equity, revenue, income, other_income, expense, cost_of_goods_sold, other_expense.
    - accountNumber follows: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx COGS, 6xxx expenses, 7xxx-9xxx other.

  { kind: "show-remaining", ... }
    - User asks "what's left?", "show pending", etc.

  { kind: "session-complete", ... }
    - User says "I'm done", "finish session", "that's all".

Multiple actions in one message: emit one action per (contact, intent). E.g. "AT&T is Utilities, Einstein we ate there" → [categorize AT&T, propose-categorize Einstein].

For the no-contact bucket: pendingContacts may include a row with sessionContactId for a contact named "(no contact)" or similar. Only target that row when the user explicitly says "the no-contact ones" or "the unassigned transactions" — otherwise leave it alone.

If the user names a contact NOT in PENDING and doesn't substring-match any pending contact name, return kind: "unclear" with a clarifyingQuestion.

narration: short status sentence summarizing what you parsed ("Categorizing AT&T as Utilities, proposing Meals & Entertainment for Einstein."). Do NOT claim categorization succeeded — the server hasn't executed yet.

Return JSON only, no surrounding prose.`;
}

export async function parseCategorizationIntent(
  input: ParseInput,
): Promise<IntentParseResult> {
  const prompt = buildPrompt(input);

  let raw: string;
  try {
    const response = await chatCompletion(
      {
        userId: input.actorUserId ?? null,
        orgId: input.organizationId ?? null,
        actor: 'user',
        feature: 'intent-parse',
      },
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'CategorizationIntent',
            strict: true,
            schema: ACTION_SCHEMA,
          },
        },
      },
    );
    raw = response.choices[0]?.message?.content ?? '';
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'intent parse failed');
    return {
      kind: 'unclear',
      clarifyingQuestion: 'I could not parse that — say it again with the contact and account name?',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ raw }, 'intent parse: model returned non-JSON');
    return {
      kind: 'unclear',
      clarifyingQuestion: 'I could not parse that — say it again?',
    };
  }

  return normalizeParsed(parsed);
}

function normalizeParsed(p: unknown): IntentParseResult {
  if (typeof p !== 'object' || p === null) {
    return { kind: 'unclear', clarifyingQuestion: 'I could not parse that.' };
  }
  const obj = p as Record<string, unknown>;
  if (obj.kind === 'unclear') {
    const q =
      typeof obj.clarifyingQuestion === 'string' && obj.clarifyingQuestion.trim()
        ? obj.clarifyingQuestion
        : 'Could you clarify which contact and account?';
    return { kind: 'unclear', clarifyingQuestion: q };
  }
  if (obj.kind === 'actions' && Array.isArray(obj.actions)) {
    const actions: IntentAction[] = [];
    const droppedActions: Array<{ kind: unknown; reason: string }> = [];
    const rawActionsCount = obj.actions.length;
    for (const a of obj.actions) {
      if (typeof a !== 'object' || a === null) {
        droppedActions.push({ kind: null, reason: 'not an object' });
        continue;
      }
      const ao = a as Record<string, unknown>;
      const kind = ao.kind;
      if (kind === 'categorize') {
        if (
          typeof ao.sessionContactId === 'string' &&
          typeof ao.accountIdHint === 'string' &&
          ao.sessionContactId.length > 0 &&
          ao.accountIdHint.length > 0
        ) {
          actions.push({
            kind: 'categorize',
            sessionContactId: ao.sessionContactId,
            contactNameMatched: String(ao.contactNameMatched ?? ''),
            accountIdHint: ao.accountIdHint,
            accountLabelMatched: String(ao.accountLabelMatched ?? ''),
          });
        }
      } else if (kind === 'propose-categorize') {
        if (
          typeof ao.sessionContactId === 'string' &&
          ao.sessionContactId.length > 0 &&
          typeof ao.proposedAccountId === 'string' &&
          ao.proposedAccountId.length > 0
        ) {
          actions.push({
            kind: 'propose-categorize',
            sessionContactId: ao.sessionContactId,
            contactNameMatched: String(ao.contactNameMatched ?? ''),
            proposedAccountId: ao.proposedAccountId,
            proposedAccountLabel: String(ao.proposedAccountLabel ?? ''),
            rationale: String(ao.rationale ?? ''),
          });
        }
      } else if (kind === 'confirm-pending') {
        actions.push({ kind: 'confirm-pending' });
      } else if (kind === 'skip') {
        if (typeof ao.sessionContactId === 'string' && ao.sessionContactId.length > 0) {
          actions.push({
            kind: 'skip',
            sessionContactId: ao.sessionContactId,
            contactNameMatched: String(ao.contactNameMatched ?? ''),
          });
        }
      } else if (kind === 'create-account-and-categorize') {
        const proposed = ao.proposed as Record<string, unknown> | null;
        if (
          typeof ao.sessionContactId === 'string' &&
          ao.sessionContactId.length > 0 &&
          proposed &&
          typeof proposed.accountName === 'string' &&
          typeof proposed.accountNumber === 'string' &&
          typeof proposed.gaapType === 'string'
        ) {
          actions.push({
            kind: 'create-account-and-categorize',
            sessionContactId: ao.sessionContactId,
            contactNameMatched: String(ao.contactNameMatched ?? ''),
            proposed: {
              accountName: proposed.accountName,
              accountNumber: proposed.accountNumber,
              gaapType: proposed.gaapType,
              description: typeof proposed.description === 'string' ? proposed.description : '',
            },
          });
        }
      } else if (kind === 'show-remaining') {
        actions.push({ kind: 'show-remaining' });
      } else if (kind === 'session-complete') {
        actions.push({ kind: 'session-complete' });
      } else {
        droppedActions.push({ kind, reason: 'unrecognized kind' });
      }
    }
    // Forensic: log any dropped actions so we see what the model emitted vs
    // what we kept. Dropped happens when required fields are null/missing.
    if (droppedActions.length > 0) {
      logger.warn(
        { droppedActions, rawActionsCount, validActionsCount: actions.length },
        'parsed actions dropped during normalization',
      );
    }
    const narration =
      typeof obj.narration === 'string' && obj.narration.trim()
        ? obj.narration
        : 'Working on it.';
    return { kind: 'actions', actions, narration };
  }
  return { kind: 'unclear', clarifyingQuestion: 'I could not parse that.' };
}
