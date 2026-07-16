-- QBO mirror foundation tables. Adds the four tables that the upcoming
-- QuickBooks Online migration + two-way mirror feature needs:
--
--   qbo_entity_map      — bidirectional record mapping (qboId <-> localId)
--   qbo_outbound_queue  — local→QBO push queue, drained by an Inngest worker
--   qbo_mirror_settings — per-(org, realm) entity toggles + default account
--   qbo_conflicts       — detected conflicts pending user resolution
--
-- All four are NEW tables — no edits to existing tables. Hand-written
-- (skipping drizzle-kit generate) to sidestep an unrelated transaction_splits
-- drift in the schema diff. Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.qbo_entity_map (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  entity_type varchar(32) NOT NULL,
  qbo_id varchar(64) NOT NULL,
  local_id varchar NOT NULL,
  qbo_sync_token varchar(32),
  last_qbo_updated_at timestamp with time zone,
  last_local_updated_at timestamp with time zone,
  last_sync_at timestamp with time zone,
  sync_status varchar(16) NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_entity_map_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_qbo_entity_map_realm_type_qbo
  ON public.qbo_entity_map (realm_id, entity_type, qbo_id);
CREATE UNIQUE INDEX IF NOT EXISTS ix_qbo_entity_map_realm_type_local
  ON public.qbo_entity_map (realm_id, entity_type, local_id);
CREATE INDEX IF NOT EXISTS ix_qbo_entity_map_org_id
  ON public.qbo_entity_map (organization_id);
CREATE INDEX IF NOT EXISTS ix_qbo_entity_map_sync_status
  ON public.qbo_entity_map (sync_status);


CREATE TABLE IF NOT EXISTS public.qbo_outbound_queue (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  entity_type varchar(32) NOT NULL,
  local_id varchar NOT NULL,
  qbo_id varchar(64),
  operation varchar(16) NOT NULL,
  payload json NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  scheduled_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_outbound_queue_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id)
);

CREATE INDEX IF NOT EXISTS ix_qbo_outbound_queue_org_id
  ON public.qbo_outbound_queue (organization_id);
CREATE INDEX IF NOT EXISTS ix_qbo_outbound_queue_realm_id
  ON public.qbo_outbound_queue (realm_id);
CREATE INDEX IF NOT EXISTS ix_qbo_outbound_queue_status_scheduled
  ON public.qbo_outbound_queue (status, scheduled_at);


CREATE TABLE IF NOT EXISTS public.qbo_mirror_settings (
  id varchar PRIMARY KEY NOT NULL,
  organization_id varchar NOT NULL,
  realm_id varchar NOT NULL,
  mirror_accounts boolean NOT NULL DEFAULT true,
  mirror_customers boolean NOT NULL DEFAULT true,
  mirror_vendors boolean NOT NULL DEFAULT true,
  mirror_invoices boolean NOT NULL DEFAULT true,
  mirror_bills boolean NOT NULL DEFAULT true,
  mirror_payments boolean NOT NULL DEFAULT true,
  mirror_bill_payments boolean NOT NULL DEFAULT true,
  default_account_id varchar,
  category_mapping_overrides json,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_mirror_settings_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT qbo_mirror_settings_default_account_id_fkey
    FOREIGN KEY (default_account_id) REFERENCES public.chart_of_accounts(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ix_qbo_mirror_settings_org_realm
  ON public.qbo_mirror_settings (organization_id, realm_id);


CREATE TABLE IF NOT EXISTS public.qbo_conflicts (
  id varchar PRIMARY KEY NOT NULL,
  entity_map_id varchar NOT NULL,
  organization_id varchar NOT NULL,
  detected_at timestamp with time zone NOT NULL DEFAULT now(),
  qbo_snapshot json NOT NULL,
  local_snapshot json NOT NULL,
  resolution varchar(16),
  resolved_at timestamp with time zone,
  resolved_by_user_id varchar,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT qbo_conflicts_entity_map_id_fkey
    FOREIGN KEY (entity_map_id) REFERENCES public.qbo_entity_map(id),
  CONSTRAINT qbo_conflicts_org_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id),
  CONSTRAINT qbo_conflicts_resolved_by_user_id_fkey
    FOREIGN KEY (resolved_by_user_id) REFERENCES public.users(id)
);

CREATE INDEX IF NOT EXISTS ix_qbo_conflicts_entity_map_id
  ON public.qbo_conflicts (entity_map_id);
CREATE INDEX IF NOT EXISTS ix_qbo_conflicts_org_unresolved
  ON public.qbo_conflicts (organization_id, resolved_at);
