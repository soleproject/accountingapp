-- Signatures — DocuSign-style e-signing under Documents.
--
-- A signature_request freezes one PDF (from an organizer_documents source or a
-- fresh upload) and routes it to one or more recipients. Each recipient signs
-- via an unguessable public token link; fields are placed by the owner with
-- normalized (0..1) coordinates so they're DPI-independent. When everyone has
-- signed, the PDF is stamped (pdf-lib) into completed_pdf_path. signature_events
-- is the append-only audit trail.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS public.signature_requests (
  id                 varchar PRIMARY KEY,
  organization_id    varchar     NOT NULL,
  user_id            varchar,
  title              text        NOT NULL DEFAULT '',
  message            text        NOT NULL DEFAULT '',
  status             varchar     NOT NULL DEFAULT 'draft',   -- draft|sent|completed|declined|voided
  source_document_id varchar,                                -- organizer_documents.id, if drawn from Documents
  source_pdf_path    text,                                   -- frozen signing PDF (signatures bucket)
  completed_pdf_path text,                                   -- final stamped PDF
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  completed_at       timestamptz
);

ALTER TABLE public.signature_requests
  DROP CONSTRAINT IF EXISTS signature_requests_organization_id_fkey,
  ADD  CONSTRAINT signature_requests_organization_id_fkey
       FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.signature_requests
  DROP CONSTRAINT IF EXISTS signature_requests_source_document_id_fkey,
  ADD  CONSTRAINT signature_requests_source_document_id_fkey
       FOREIGN KEY (source_document_id) REFERENCES public.organizer_documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_signature_requests_org_created
  ON public.signature_requests (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.signature_recipients (
  id                 varchar PRIMARY KEY,
  request_id         varchar     NOT NULL,
  name               text        NOT NULL DEFAULT '',
  email              text        NOT NULL DEFAULT '',
  phone              text,
  signing_order      integer     NOT NULL DEFAULT 0,
  status             varchar     NOT NULL DEFAULT 'pending',  -- pending|viewed|signed|declined
  token              varchar     NOT NULL,                    -- public signing link
  viewed_at          timestamptz,
  signed_at          timestamptz,
  decline_reason     text,
  signed_ip          varchar,
  signed_user_agent  text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.signature_recipients
  DROP CONSTRAINT IF EXISTS signature_recipients_request_id_fkey,
  ADD  CONSTRAINT signature_recipients_request_id_fkey
       FOREIGN KEY (request_id) REFERENCES public.signature_requests(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_signature_recipients_token
  ON public.signature_recipients (token);
CREATE INDEX IF NOT EXISTS ix_signature_recipients_request
  ON public.signature_recipients (request_id);

CREATE TABLE IF NOT EXISTS public.signature_fields (
  id                   varchar PRIMARY KEY,
  request_id           varchar     NOT NULL,
  recipient_id         varchar     NOT NULL,
  page                 integer     NOT NULL DEFAULT 0,        -- 0-based page index
  x                    numeric     NOT NULL,                  -- normalized 0..1 (left)
  y                    numeric     NOT NULL,                  -- normalized 0..1 (top)
  w                    numeric     NOT NULL,                  -- normalized 0..1
  h                    numeric     NOT NULL,                  -- normalized 0..1
  type                 varchar     NOT NULL,                  -- signature|initials|date|text|name|checkbox
  required             boolean     NOT NULL DEFAULT true,
  value                text,                                  -- filled at sign time
  signature_image_path text,                                  -- drawn-signature PNG (signatures bucket)
  created_at           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.signature_fields
  DROP CONSTRAINT IF EXISTS signature_fields_request_id_fkey,
  ADD  CONSTRAINT signature_fields_request_id_fkey
       FOREIGN KEY (request_id) REFERENCES public.signature_requests(id) ON DELETE CASCADE;

ALTER TABLE public.signature_fields
  DROP CONSTRAINT IF EXISTS signature_fields_recipient_id_fkey,
  ADD  CONSTRAINT signature_fields_recipient_id_fkey
       FOREIGN KEY (recipient_id) REFERENCES public.signature_recipients(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_signature_fields_request
  ON public.signature_fields (request_id);

CREATE TABLE IF NOT EXISTS public.signature_events (
  id           varchar PRIMARY KEY,
  request_id   varchar     NOT NULL,
  recipient_id varchar,
  type         varchar     NOT NULL,   -- created|sent|viewed|signed|completed|declined|reminded|voided|consented
  at           timestamptz NOT NULL DEFAULT now(),
  ip           varchar,
  user_agent   text,
  meta         jsonb
);

ALTER TABLE public.signature_events
  DROP CONSTRAINT IF EXISTS signature_events_request_id_fkey,
  ADD  CONSTRAINT signature_events_request_id_fkey
       FOREIGN KEY (request_id) REFERENCES public.signature_requests(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_signature_events_request
  ON public.signature_events (request_id, at);
