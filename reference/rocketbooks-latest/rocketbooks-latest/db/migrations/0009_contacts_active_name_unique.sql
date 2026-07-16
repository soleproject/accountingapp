-- Partial unique index on contacts(organization_id, lower(trim(contact_name)))
-- restricted to is_active=true rows. Prevents two active contacts in the same
-- org from sharing a normalized-equal name, even under concurrent inserts.
--
-- Pre-condition: scripts/dedupe-contacts.ts MUST run first to merge any
-- existing duplicates. Otherwise the existing dupes (e.g. three "GitHub"
-- rows from successive Veryfi imports) would block index creation.
--
-- Once this index exists, app code stays consistent via the resolver
-- (resolve-contact-ai.ts, ensure-contact.ts) which uses
-- normalizeContactNameForMatch — the index is the last-line defense if
-- app logic regresses or a new code path forgets to dedupe.
--
-- Note: matches the *trimmed/lowered* name only. The normalize helper
-- additionally strips corp suffixes ("Inc", "LLC") at the application
-- layer; the index is intentionally narrower so the DB constraint is
-- mechanical (no string-cleaning rules embedded in SQL). The app layer
-- catches the suffix variants before they reach the INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS ix_contacts_org_active_name_uniq
  ON contacts (organization_id, lower(trim(contact_name)))
  WHERE is_active = true;
