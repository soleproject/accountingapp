import {
  pgTable,
  varchar,
  text,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/**
 * User-submitted bug reports and feature recommendations.
 *
 * Surfaced via:
 *   - /feedback                 — reporter's own reports (read + comment)
 *   - /super-admin/feedback     — triage + status changes + comments
 *
 * Lifecycle (status): 'open' -> 'in_progress' -> 'resolved' -> 'closed'.
 * No notifications: status updates and admin replies are visible only when
 * the reporter visits /feedback.
 */
export const feedbackReports = pgTable(
  'feedback_reports',
  {
    id: varchar().primaryKey().notNull(),
    organizationId: varchar('organization_id'),
    reporterUserId: varchar('reporter_user_id').notNull(),
    kind: varchar().notNull(), // 'bug' | 'recommendation'
    title: varchar().notNull(),
    description: text().notNull(),
    status: varchar().notNull().default('open'), // 'open' | 'in_progress' | 'resolved' | 'closed'
    assignedAdminId: varchar('assigned_admin_id'),
    pageUrl: varchar('page_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [
    index('ix_feedback_reports_reporter').on(table.reporterUserId, table.createdAt),
    index('ix_feedback_reports_status').on(table.status, table.createdAt),
    index('ix_feedback_reports_kind').on(table.kind),
    index('ix_feedback_reports_org').on(table.organizationId),
  ],
);

export const feedbackReportComments = pgTable(
  'feedback_report_comments',
  {
    id: varchar().primaryKey().notNull(),
    reportId: varchar('report_id').notNull(),
    authorUserId: varchar('author_user_id').notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    body: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  (table) => [index('ix_feedback_report_comments_report').on(table.reportId, table.createdAt)],
);
