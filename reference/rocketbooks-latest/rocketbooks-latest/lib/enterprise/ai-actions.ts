/**
 * AI outreach taxonomy — maps each "needs attention" issue type to who the AI
 * contacts, what the nudge does, the default channel, and the trigger/cooldown
 * rules. Shared by the dashboard (labels) and the draft/send server actions
 * (prompt construction). No DB or server-only imports so it's safe anywhere.
 */

export type OutreachIssueType =
  | 'to_review'
  | 'broken_bank'
  | 'overdue_bills'
  | 'overdue_invoices'
  | 'recon_off'
  | 'findings_open'
  | 'onboarding'
  | 'meeting_followup';

export type OutreachChannel = 'email' | 'sms' | 'chat';
export type OutreachTarget = 'client_owner' | 'invoice_customers';
export type OutreachStatus = 'none' | 'drafted' | 'sent' | 'awaiting_response' | 'resolved' | 'dismissed';

/** Who ultimately has to act on an issue. Drives the dashboard tab + row badge. */
export type OutreachOwner = 'ai' | 'client' | 'pro';
/**
 * What the dashboard "AI Action" does for an issue:
 *  - nudge:    AI drafts + sends a reminder to the client.
 *  - ask_send: AI asks the client for the go-ahead first (AR — never contacts
 *              the client's own customers without consent).
 *  - route:    bookkeeper-owned work; no client message — send the pro to the
 *              workspace (reconciliation, meeting debrief).
 */
export type OutreachActionMode = 'nudge' | 'ask_send' | 'route';

export interface OutreachActionDef {
  issueType: OutreachIssueType;
  /** Short noun for the issue, used in labels. */
  label: string;
  /** Who ultimately must act on this issue. */
  owner: OutreachOwner;
  /** What the AI Action button does for this issue. */
  actionMode: OutreachActionMode;
  /** Who the AI contacts. */
  target: OutreachTarget;
  /** Preferred channel when the pro doesn't pick one. */
  defaultChannel: OutreachChannel;
  /**
   * If true, the AI does NOT contact third parties directly — it first asks the
   * client owner for the go-ahead. Used for AR: we never message the client's
   * own customers without their explicit OK.
   */
  requiresClientConfirmation: boolean;
  /** Don't re-contact the same issue within this many days. */
  cooldownDays: number;
  /** Verb phrase shown on the button / "ready" state, e.g. "Nudge client to…". */
  readyVerb: string;
  /** One-line plain-English instruction handed to the LLM to draft the message. */
  draftIntent: string;
}

export const AI_ACTION_TAXONOMY: Record<OutreachIssueType, OutreachActionDef> = {
  broken_bank: {
    issueType: 'broken_bank',
    label: 'Bank reconnect',
    owner: 'client',
    actionMode: 'nudge',
    target: 'client_owner',
    defaultChannel: 'sms',
    requiresClientConfirmation: false,
    cooldownDays: 2,
    readyVerb: 'Ask client to reconnect their bank',
    draftIntent:
      "Ask the client to reconnect their bank connection in RocketBooks so transactions keep syncing. Explain it takes ~1 minute and that categorization is paused until it's fixed.",
  },
  to_review: {
    issueType: 'to_review',
    label: 'Transaction review',
    owner: 'client',
    actionMode: 'nudge',
    target: 'client_owner',
    defaultChannel: 'email',
    requiresClientConfirmation: false,
    cooldownDays: 5,
    readyVerb: 'Nudge client to finish the AI review',
    draftIntent:
      'Nudge the client to log in and approve the transactions the AI has categorized, so the books can be closed for the period.',
  },
  overdue_bills: {
    issueType: 'overdue_bills',
    label: 'Overdue bills',
    owner: 'client',
    actionMode: 'nudge',
    target: 'client_owner',
    defaultChannel: 'email',
    requiresClientConfirmation: false,
    cooldownDays: 4,
    readyVerb: 'Remind client of bills due',
    draftIntent:
      'Let the client know they have bills past due that need paying, and offer to walk them through it.',
  },
  overdue_invoices: {
    issueType: 'overdue_invoices',
    label: 'Overdue invoices (AR)',
    owner: 'client',
    actionMode: 'ask_send',
    target: 'client_owner',
    requiresClientConfirmation: true,
    defaultChannel: 'email',
    cooldownDays: 4,
    readyVerb: 'Ask client before nudging their payers',
    draftIntent:
      "The client has overdue invoices owed BY THEIR OWN CUSTOMERS. Do NOT contact those customers. Instead ask the client owner whether they'd like us to send polite payment reminders to their outstanding customers on their behalf — wait for their go-ahead.",
  },
  recon_off: {
    issueType: 'recon_off',
    label: 'Reconciliation',
    owner: 'pro',
    actionMode: 'route',
    target: 'client_owner',
    defaultChannel: 'email',
    requiresClientConfirmation: false,
    cooldownDays: 3,
    readyVerb: 'Request the missing statement',
    draftIntent:
      "Tell the client their account isn't reconciling and request the latest bank statement (or an explanation of the discrepancy) so we can tie it out.",
  },
  findings_open: {
    issueType: 'findings_open',
    label: 'Book-review findings',
    owner: 'pro',
    actionMode: 'route',
    target: 'client_owner',
    defaultChannel: 'email',
    requiresClientConfirmation: false,
    cooldownDays: 3,
    readyVerb: 'Review the book-review findings',
    draftIntent:
      'The audit sweep flagged book-review findings (duplicates, integrity, or anomalies) that need clearing. Route the owner to the Book Review workspace to resolve them.',
  },
  onboarding: {
    issueType: 'onboarding',
    label: 'Onboarding',
    owner: 'client',
    actionMode: 'nudge',
    target: 'client_owner',
    defaultChannel: 'email',
    requiresClientConfirmation: false,
    cooldownDays: 3,
    readyVerb: 'Help client finish setup',
    draftIntent:
      'Encourage the client to finish setting up their RocketBooks account so we can start keeping their books.',
  },
  meeting_followup: {
    issueType: 'meeting_followup',
    label: 'Meeting follow-up',
    owner: 'pro',
    actionMode: 'route',
    target: 'client_owner',
    defaultChannel: 'email',
    requiresClientConfirmation: false,
    cooldownDays: 3,
    readyVerb: 'Chase meeting notes',
    draftIntent:
      'Politely follow up after the recent meeting to collect any notes or outstanding items discussed.',
  },
};

/** Short badge label for who owns an issue. */
export function ownerLabel(owner: OutreachOwner): string {
  switch (owner) {
    case 'client':
      return 'Client';
    case 'pro':
      return 'You';
    case 'ai':
      return 'AI';
  }
}

/** Human label for the current AI status of an issue (drives the "AI Action" column). */
export function outreachStatusLabel(
  status: OutreachStatus | undefined,
  issueType: OutreachIssueType,
): string {
  const def = AI_ACTION_TAXONOMY[issueType];
  switch (status) {
    case 'sent':
    case 'awaiting_response':
      return def.requiresClientConfirmation ? 'Asked client to approve outreach' : 'Nudged client — awaiting reply';
    case 'drafted':
      return 'Draft ready for your review';
    case 'resolved':
      return 'Resolved';
    case 'dismissed':
      return 'Dismissed';
    default:
      return def.readyVerb;
  }
}

/** Build the OpenAI chat messages to draft an outreach message for an issue. */
export function buildOutreachDraftMessages(input: {
  issueType: OutreachIssueType;
  channel: OutreachChannel;
  clientBusinessName: string;
  ownerFirstName: string | null;
  detail: string; // e.g. "47 transactions awaiting review, oldest 31 days"
  firmName: string;
}): { system: string; user: string } {
  const def = AI_ACTION_TAXONOMY[input.issueType];
  const lengthGuide =
    input.channel === 'sms'
      ? 'Keep it under 320 characters, friendly and plain — no subject line, no signature block.'
      : input.channel === 'chat'
        ? 'Keep it to 2-3 short sentences, conversational.'
        : 'Keep it to a short, warm email of 3-5 sentences with a clear ask.';

  const system = [
    `You are the AI bookkeeping assistant for ${input.firmName}, writing on behalf of the bookkeeping team to a client.`,
    'Write a single outreach message. Be warm, concise, and professional. Never invent specific dollar amounts, dates, or numbers beyond what you are given.',
    'Do not include placeholders like [Name] — use the details provided. End an email with a brief friendly sign-off from the bookkeeping team.',
    lengthGuide,
  ].join(' ');

  const user = [
    `Client business: ${input.clientBusinessName}.`,
    input.ownerFirstName ? `Owner first name: ${input.ownerFirstName}.` : 'Owner name unknown — greet generically.',
    `Situation: ${input.detail}.`,
    `Goal: ${def.draftIntent}`,
    input.channel === 'email' ? 'Return only the email body (no subject line).' : 'Return only the message text.',
  ].join('\n');

  return { system, user };
}

/** Suggested subject line for email outreach. */
export function outreachSubject(issueType: OutreachIssueType, clientBusinessName: string): string {
  const map: Record<OutreachIssueType, string> = {
    broken_bank: `Action needed: reconnect your bank for ${clientBusinessName}`,
    to_review: `A few transactions need your review`,
    overdue_bills: `Heads up: bills coming due for ${clientBusinessName}`,
    overdue_invoices: `Want us to send payment reminders for ${clientBusinessName}?`,
    recon_off: `Quick favor: latest bank statement for ${clientBusinessName}`,
    findings_open: `Book-review items to clear for ${clientBusinessName}`,
    onboarding: `Let's finish setting up ${clientBusinessName}`,
    meeting_followup: `Following up on our recent meeting`,
  };
  return map[issueType];
}
