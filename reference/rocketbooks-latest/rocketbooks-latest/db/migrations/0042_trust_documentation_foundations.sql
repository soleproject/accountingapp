-- Phase 0 of the Trustee Resolutions & Documentation module.
-- Adds the trust-level metadata + per-trustee acting-rules the doc-
-- generation pipeline needs to populate resolution templates. Phase 1
-- (document_records / Inngest worker / template engine) is the next
-- migration; this one only establishes the data foundations.
--
-- Two scope notes:
--   1. trust_metadata is one-to-one with organizations (when
--      feature_pack='beneficial_trust' is enabled). The row is created
--      lazily — first time the UI lazy-prompts for state of formation
--      on a state-sensitive doc, or first time the user opens the new
--      /trust-documents area.
--   2. Beneficiary K-1 fields (TIN, mailing_address, vested_status,
--      ack_signed_at) deliberately deferred to Phase 2. TIN needs
--      encryption-at-rest infra and the K-1 packet is where that
--      design conversation belongs.

CREATE TABLE IF NOT EXISTS trust_metadata (
  organization_id varchar PRIMARY KEY REFERENCES organizations(id),

  -- Identity of the trust as a legal entity (often differs from the
  -- org's commercial name).
  trust_name varchar,
  effective_date date,

  -- Two-letter US state code for governing law + situs. Separate
  -- because a trust can elect to move situs (e.g., to a creditor-
  -- friendly state) without changing governing law. Both are nullable
  -- and asked for lazily — first doc generator that needs state
  -- prompts the user.
  governing_state varchar,
  situs_state varchar,

  ein varchar,
  -- 'MM-DD'. Most trusts run calendar year ('12-31'); some elect
  -- fiscal. Stored as text so the UI can validate without a date-coercion
  -- dance.
  fiscal_year_end varchar,

  -- Grantor (settlor). May be a Contacts row, may be a person who
  -- never existed in contacts (e.g., deceased grantor of an
  -- irrevocable trust). Name field stands alone for that case;
  -- contact_id links when known.
  grantor_name varchar,
  grantor_contact_id varchar REFERENCES contacts(id),

  -- Trust-wide default for "what's the rule when trustees act?"
  -- Per-trustee overrides could come later; for now we read this for
  -- every resolution-signing flow.
  --   sole       — any single trustee may act
  --   majority   — majority of trustees must consent
  --   unanimous  — all trustees must consent
  default_signing_authority varchar,

  -- Optional pointer to the uploaded trust-instrument document. Wired
  -- in Phase 1 once /trust-documents lands.
  trust_agreement_doc_id varchar,

  -- Free-form notes for anything that doesn't fit (the proprietary
  -- "Nexxess-Approved" caveat, atypical clauses, etc.).
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT trust_metadata_signing_authority_chk
    CHECK (default_signing_authority IS NULL
           OR default_signing_authority IN ('sole', 'majority', 'unanimous'))
);

-- Per-trustee role + effective dates. Lets the trust review queries
-- distinguish "currently-acting trustees" (signers for new resolutions)
-- from "former trustees" (still on file for historical audits) without
-- requiring the user to delete a contact. NULL on non-trustee contacts.
-- Role is freeform text rather than enum because the trust-law
-- vocabulary varies ('Co-Trustee', 'Successor Trustee', 'Investment
-- Trustee', 'Distribution Trustee', 'Trust Protector', etc.).
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS trustee_role varchar,
  ADD COLUMN IF NOT EXISTS trustee_effective_date date,
  ADD COLUMN IF NOT EXISTS trustee_removed_at timestamptz;

-- Quick lookup for "active trustees on this org right now" — filters
-- out removed trustees in a single index hit.
CREATE INDEX IF NOT EXISTS ix_contacts_active_trustee
  ON contacts (organization_id)
  WHERE trustee_role IS NOT NULL AND trustee_removed_at IS NULL;
