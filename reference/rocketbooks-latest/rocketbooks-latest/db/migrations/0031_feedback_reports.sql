-- User-submitted bug reports and feature recommendations, plus a threaded
-- comment system shared by reporters and super admins.
--
-- Lifecycle (status column): 'open' -> 'in_progress' -> 'resolved' -> 'closed'.
-- Per-product decision (2026-05-19): no notifications, threaded comments are
-- visible to the reporter. The reporter sees their own reports + admin replies
-- via a /feedback page; super admins triage via /super-admin/feedback.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.feedback_reports (
  id varchar PRIMARY KEY,
  organization_id varchar,
  reporter_user_id varchar NOT NULL,
  -- 'bug' | 'recommendation'
  kind varchar NOT NULL,
  title varchar NOT NULL,
  description text NOT NULL,
  -- 'open' | 'in_progress' | 'resolved' | 'closed'
  status varchar NOT NULL DEFAULT 'open',
  -- Optional admin-set fields surfaced in the super-admin list.
  assigned_admin_id varchar,
  page_url varchar,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_feedback_reports_reporter
  ON public.feedback_reports (reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_feedback_reports_status
  ON public.feedback_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_feedback_reports_kind
  ON public.feedback_reports (kind);
CREATE INDEX IF NOT EXISTS ix_feedback_reports_org
  ON public.feedback_reports (organization_id);

CREATE TABLE IF NOT EXISTS public.feedback_report_comments (
  id varchar PRIMARY KEY,
  report_id varchar NOT NULL REFERENCES public.feedback_reports(id) ON DELETE CASCADE,
  author_user_id varchar NOT NULL,
  -- true when written by a super admin; renders with admin styling on the
  -- reporter's view. Cheap denormalization so we don't re-check the author's
  -- role on every render.
  is_admin boolean NOT NULL DEFAULT false,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_feedback_report_comments_report
  ON public.feedback_report_comments (report_id, created_at);
