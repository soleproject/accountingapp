import {
  pgTable,
  varchar,
  timestamp,
  integer,
  numeric,
  date,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

/**
 * One row per categorization session. A session captures a snapshot of the
 * org's uncategorized contacts at start time and tracks per-contact progress
 * through approve/skip/done states. Sessions are per-(org, user) — at most
 * one `status='active'` session per user/org. Resume support relies on
 * looking up the active session by (orgId, userId) on workspace open.
 */
export const categorizationSessions = pgTable(
  'categorization_sessions',
  {
    id: varchar().primaryKey().notNull(),
    organizationId: varchar('organization_id').notNull(),
    userId: varchar('user_id').notNull(),
    status: varchar().notNull(), // 'active' | 'completed' | 'abandoned'
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('ix_categorization_sessions_org_user_status').on(
      table.organizationId,
      table.userId,
      table.status,
    ),
  ],
);

/**
 * One row per contact in a session. Snapshots the contact's count/total/dates
 * at session start so the UI doesn't have to re-aggregate every render. The
 * recommendation fields (recommendedAccountId, recommendedSource,
 * recommendedNewAccount) are populated by the rules engine at session creation
 * and may be overwritten by AI fallback (PR2) or manual user edit.
 *
 * contactId is nullable to support the "no-contact-assigned" bucket — those
 * transactions GROUP BY NULL into a single row with a sentinel
 * contactNameSnapshot like "(no contact)".
 */
export const categorizationSessionContacts = pgTable(
  'categorization_session_contacts',
  {
    id: varchar().primaryKey().notNull(),
    sessionId: varchar('session_id').notNull(),
    contactId: varchar('contact_id'), // null for the no-contact bucket
    contactNameSnapshot: varchar('contact_name_snapshot'),
    status: varchar().notNull(), // 'pending' | 'done' | 'skipped' | 'failed'
    // Recommendation slot — populated by rules engine at session create.
    recommendedAccountId: varchar('recommended_account_id'),
    recommendedSource: varchar('recommended_source'), // 'rules' | 'ai' | 'manual' | null
    recommendedNewAccount: jsonb('recommended_new_account'), // proposed CoA when no existing fits
    // Outcome — set when applied/skipped.
    appliedAccountId: varchar('applied_account_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }),
    // Snapshot stats captured at session creation.
    transactionCount: integer('transaction_count').notNull(),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
    oldestDate: date('oldest_date'),
    newestDate: date('newest_date'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [index('ix_categorization_session_contacts_session').on(table.sessionId)],
);
