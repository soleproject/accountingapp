-- Tax return completion: self-extending form system.
--
-- Two layers, deliberately separate:
--   KNOWLEDGE layer (global, no organization_id) — the archived official forms and
--     the AI-derived "expertise" (FormSpec) for filling them. How to fill line 9 of a
--     1040 is universal, so this is learned once and reused for every client.
--   FILING layer (organization-scoped) — one client's return, every filled form
--     instance (the crawler nodes), the collected facts, and the work queue. ALL
--     client-specific data lives here; nothing client-specific touches the knowledge layer.
--
-- Conventions match the rest of this DB (see 0073/0092): public schema, varchar
-- app-generated PKs/FKs, separate ADD CONSTRAINT blocks, ix_/ux_ indexes, and text
-- status columns with documented allowed values rather than new pg enum types.
-- Idempotent — safe to re-run.

-- ===========================================================================
-- KNOWLEDGE LAYER (global, system-owned; written only by the pipeline)
-- ===========================================================================

-- Form identity, independent of tax year.
-- return_types/entity_types use documented string values (entity_types mirror the
-- org_entity_type enum: llc|c_corp|s_corp|partnership|sole_prop|beneficial_trust|
-- business_trust|nonprofit|other).
CREATE TABLE IF NOT EXISTS public.tax_form_catalog (
  id            varchar PRIMARY KEY,
  jurisdiction  varchar     NOT NULL,                 -- 'US' or state code: 'CA','NY',...
  form_code     varchar     NOT NULL,                 -- '1040','SCH_C','4562','CA_540'
  title         text        NOT NULL DEFAULT '',
  return_types  text[]      NOT NULL DEFAULT '{}',    -- {'personal'} / {'business'}
  entity_types  text[]      NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_form_catalog_jur_code
  ON public.tax_form_catalog (jurisdiction, form_code);

-- The archive: provenance + the actual blank PDFs we acquired for a given year.
CREATE TABLE IF NOT EXISTS public.tax_form_sources (
  id                varchar PRIMARY KEY,
  catalog_id        varchar     NOT NULL,
  tax_year          integer     NOT NULL,
  source_url        text        NOT NULL,             -- canonical IRS/state URL we pulled from
  source_kind       varchar     NOT NULL DEFAULT 'official', -- official|provider|manual_upload
  form_pdf_path     text        NOT NULL,             -- Storage path of the archived blank form
  instructions_path text,                             -- Storage path of the instruction PDF, if any
  sha256            varchar     NOT NULL,             -- integrity hash of the form PDF
  pdf_version       varchar,                          -- e.g. '1.7' (affects AcroForm fill)
  field_dump        jsonb,                            -- raw extracted AcroForm field names/types
  retrieved_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_form_sources
  DROP CONSTRAINT IF EXISTS tax_form_sources_catalog_id_fkey,
  ADD  CONSTRAINT tax_form_sources_catalog_id_fkey
       FOREIGN KEY (catalog_id) REFERENCES public.tax_form_catalog(id) ON DELETE CASCADE;

-- same form/year may have revisions; the sha256 distinguishes them.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_form_sources_catalog_year_hash
  ON public.tax_form_sources (catalog_id, tax_year, sha256);
CREATE INDEX IF NOT EXISTS ix_tax_form_sources_catalog_year
  ON public.tax_form_sources (catalog_id, tax_year);

-- The expertise: structured FormSpec derived from a source. Versioned + trust-laddered.
-- trust_status: learned (AI-derived, unverified) | verified | locked | deprecated
CREATE TABLE IF NOT EXISTS public.tax_form_specs (
  id            varchar PRIMARY KEY,
  source_id     varchar     NOT NULL,
  catalog_id    varchar     NOT NULL,
  tax_year      integer     NOT NULL,
  spec_version  integer     NOT NULL DEFAULT 1,
  spec          jsonb       NOT NULL,                 -- the FormSpec document (see lib/tax/spec.ts)
  spec_hash     varchar     NOT NULL,                 -- hash of `spec` for change detection
  trust_status  varchar     NOT NULL DEFAULT 'learned',
  confidence    numeric,                              -- model self-rated 0..1
  model         varchar,                              -- which model derived it (audit)
  is_active     boolean     NOT NULL DEFAULT true,    -- the chosen spec for this form/year
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_form_specs
  DROP CONSTRAINT IF EXISTS tax_form_specs_source_id_fkey,
  ADD  CONSTRAINT tax_form_specs_source_id_fkey
       FOREIGN KEY (source_id) REFERENCES public.tax_form_sources(id) ON DELETE CASCADE;

ALTER TABLE public.tax_form_specs
  DROP CONSTRAINT IF EXISTS tax_form_specs_catalog_id_fkey,
  ADD  CONSTRAINT tax_form_specs_catalog_id_fkey
       FOREIGN KEY (catalog_id) REFERENCES public.tax_form_catalog(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_form_specs_source_version
  ON public.tax_form_specs (source_id, spec_version);

-- Exactly one active spec per form per year per jurisdiction.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_form_specs_one_active
  ON public.tax_form_specs (catalog_id, tax_year)
  WHERE is_active;

-- Audit of promotions up the trust ladder (e.g. learned -> verified by a preparer).
CREATE TABLE IF NOT EXISTS public.tax_form_spec_reviews (
  id               varchar PRIMARY KEY,
  spec_id          varchar     NOT NULL,
  reviewer_user_id varchar     NOT NULL,
  from_status      varchar     NOT NULL,
  to_status        varchar     NOT NULL,
  fixtures_passed  integer     NOT NULL DEFAULT 0,    -- golden test cases that passed
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_form_spec_reviews
  DROP CONSTRAINT IF EXISTS tax_form_spec_reviews_spec_id_fkey,
  ADD  CONSTRAINT tax_form_spec_reviews_spec_id_fkey
       FOREIGN KEY (spec_id) REFERENCES public.tax_form_specs(id) ON DELETE CASCADE;

ALTER TABLE public.tax_form_spec_reviews
  DROP CONSTRAINT IF EXISTS tax_form_spec_reviews_reviewer_user_id_fkey,
  ADD  CONSTRAINT tax_form_spec_reviews_reviewer_user_id_fkey
       FOREIGN KEY (reviewer_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_tax_form_spec_reviews_spec
  ON public.tax_form_spec_reviews (spec_id);

-- ===========================================================================
-- FILING LAYER (organization-scoped; all client data lives here)
-- ===========================================================================

-- Top-level filing; the root of the crawl.
-- status: collecting | crawling | review | complete | archived
-- entity_type mirrors the org_entity_type enum string values.
CREATE TABLE IF NOT EXISTS public.tax_returns (
  id                 varchar PRIMARY KEY,
  organization_id    varchar     NOT NULL,
  client_contact_id  varchar,                         -- null = the org itself
  tax_year           integer     NOT NULL,
  return_type        varchar     NOT NULL,            -- 'personal' | 'business'
  entity_type        varchar,
  jurisdictions      text[]      NOT NULL DEFAULT '{}', -- {'US','CA'}
  seed_form_code     varchar     NOT NULL,            -- '1040' / '1065' — where the crawl starts
  status             varchar     NOT NULL DEFAULT 'collecting',
  created_by_user_id varchar     NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_returns
  DROP CONSTRAINT IF EXISTS tax_returns_organization_id_fkey,
  ADD  CONSTRAINT tax_returns_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.tax_returns
  DROP CONSTRAINT IF EXISTS tax_returns_client_contact_id_fkey,
  ADD  CONSTRAINT tax_returns_client_contact_id_fkey
       FOREIGN KEY (client_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.tax_returns
  DROP CONSTRAINT IF EXISTS tax_returns_created_by_user_id_fkey,
  ADD  CONSTRAINT tax_returns_created_by_user_id_fkey
       FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_tax_returns_org_year
  ON public.tax_returns (organization_id, tax_year);

-- The crawler nodes: one row per form instance discovered in a return.
-- The dependency graph is the parent_form_id self-reference.
-- status: pending|acquiring|comprehending|needs_input|ready|filling|filled|verifying|verified|failed|skipped
-- relationship: attaches | carries_to | supports | state_of
CREATE TABLE IF NOT EXISTS public.tax_return_forms (
  id              varchar PRIMARY KEY,
  return_id       varchar     NOT NULL,
  organization_id varchar     NOT NULL,               -- denormalized for org-scoped queries
  catalog_id      varchar,
  spec_id         varchar,                            -- the expertise used to fill it
  form_code       varchar     NOT NULL,
  jurisdiction    varchar     NOT NULL,
  copy_index      integer     NOT NULL DEFAULT 0,     -- 0,1,2,... for per_entity multiplicity
  instance_label  text,                               -- 'Acme LLC - Schedule C'
  parent_form_id  varchar,                            -- who referenced this (the graph edge)
  relationship    varchar,                            -- how the parent points here
  trigger_reason  text,                               -- which dependency condition fired
  depth           integer     NOT NULL DEFAULT 0,     -- distance from the seed form
  status          varchar     NOT NULL DEFAULT 'pending',
  field_values    jsonb,                              -- resolved semantic values
  computed_values jsonb,                              -- line-rule outputs
  filled_pdf_path text,                               -- completed PDF in Storage
  is_draft        boolean     NOT NULL DEFAULT true,  -- watermarked until verified + signed off
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_return_forms
  DROP CONSTRAINT IF EXISTS tax_return_forms_return_id_fkey,
  ADD  CONSTRAINT tax_return_forms_return_id_fkey
       FOREIGN KEY (return_id) REFERENCES public.tax_returns(id) ON DELETE CASCADE;

ALTER TABLE public.tax_return_forms
  DROP CONSTRAINT IF EXISTS tax_return_forms_organization_id_fkey,
  ADD  CONSTRAINT tax_return_forms_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.tax_return_forms
  DROP CONSTRAINT IF EXISTS tax_return_forms_catalog_id_fkey,
  ADD  CONSTRAINT tax_return_forms_catalog_id_fkey
       FOREIGN KEY (catalog_id) REFERENCES public.tax_form_catalog(id) ON DELETE SET NULL;

ALTER TABLE public.tax_return_forms
  DROP CONSTRAINT IF EXISTS tax_return_forms_spec_id_fkey,
  ADD  CONSTRAINT tax_return_forms_spec_id_fkey
       FOREIGN KEY (spec_id) REFERENCES public.tax_form_specs(id) ON DELETE SET NULL;

ALTER TABLE public.tax_return_forms
  DROP CONSTRAINT IF EXISTS tax_return_forms_parent_form_id_fkey,
  ADD  CONSTRAINT tax_return_forms_parent_form_id_fkey
       FOREIGN KEY (parent_form_id) REFERENCES public.tax_return_forms(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_return_forms_instance
  ON public.tax_return_forms (return_id, form_code, jurisdiction, copy_index);
CREATE INDEX IF NOT EXISTS ix_tax_return_forms_return_status
  ON public.tax_return_forms (return_id, status);
CREATE INDEX IF NOT EXISTS ix_tax_return_forms_org
  ON public.tax_return_forms (organization_id);
CREATE INDEX IF NOT EXISTS ix_tax_return_forms_parent
  ON public.tax_return_forms (parent_form_id);

-- The work queue that drives the recursive crawl.
-- kind:  acquire | comprehend | fill | verify
-- state: queued | running | succeeded | failed | canceled
CREATE TABLE IF NOT EXISTS public.tax_form_crawl_jobs (
  id              varchar PRIMARY KEY,
  return_form_id  varchar     NOT NULL,
  organization_id varchar     NOT NULL,
  kind            varchar     NOT NULL,
  state           varchar     NOT NULL DEFAULT 'queued',
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 3,
  payload         jsonb,
  result          jsonb,
  error           text,
  run_after       timestamptz NOT NULL DEFAULT now(), -- backoff scheduling
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_form_crawl_jobs
  DROP CONSTRAINT IF EXISTS tax_form_crawl_jobs_return_form_id_fkey,
  ADD  CONSTRAINT tax_form_crawl_jobs_return_form_id_fkey
       FOREIGN KEY (return_form_id) REFERENCES public.tax_return_forms(id) ON DELETE CASCADE;

ALTER TABLE public.tax_form_crawl_jobs
  DROP CONSTRAINT IF EXISTS tax_form_crawl_jobs_organization_id_fkey,
  ADD  CONSTRAINT tax_form_crawl_jobs_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- The worker's poll query: oldest runnable queued job.
CREATE INDEX IF NOT EXISTS ix_tax_form_crawl_jobs_state_runafter
  ON public.tax_form_crawl_jobs (state, run_after);
CREATE INDEX IF NOT EXISTS ix_tax_form_crawl_jobs_return_form
  ON public.tax_form_crawl_jobs (return_form_id);

-- Normalized collected facts that feed FormSpec.inputs (ref vocabulary in lib/tax/input-refs.ts).
CREATE TABLE IF NOT EXISTS public.tax_return_inputs (
  id                 varchar PRIMARY KEY,
  return_id          varchar     NOT NULL,
  organization_id    varchar     NOT NULL,
  ref                varchar     NOT NULL,            -- e.g. 'w2.box1' (controlled vocabulary)
  entity_key         varchar,                         -- ties a value to a per_entity instance
  value              jsonb       NOT NULL,
  source_document_id varchar,                         -- provenance to the organizer_documents upload
  confidence         numeric,                         -- extraction confidence 0..1
  confirmed_by_user  boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tax_return_inputs
  DROP CONSTRAINT IF EXISTS tax_return_inputs_return_id_fkey,
  ADD  CONSTRAINT tax_return_inputs_return_id_fkey
       FOREIGN KEY (return_id) REFERENCES public.tax_returns(id) ON DELETE CASCADE;

ALTER TABLE public.tax_return_inputs
  DROP CONSTRAINT IF EXISTS tax_return_inputs_organization_id_fkey,
  ADD  CONSTRAINT tax_return_inputs_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.tax_return_inputs
  DROP CONSTRAINT IF EXISTS tax_return_inputs_source_document_id_fkey,
  ADD  CONSTRAINT tax_return_inputs_source_document_id_fkey
       FOREIGN KEY (source_document_id) REFERENCES public.organizer_documents(id) ON DELETE SET NULL;

-- entity_key NULL must still be deduped per (return, ref); two partial uniques cover both cases.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_return_inputs_ref_entity
  ON public.tax_return_inputs (return_id, ref, entity_key)
  WHERE entity_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_return_inputs_ref_noentity
  ON public.tax_return_inputs (return_id, ref)
  WHERE entity_key IS NULL;
CREATE INDEX IF NOT EXISTS ix_tax_return_inputs_return
  ON public.tax_return_inputs (return_id);
