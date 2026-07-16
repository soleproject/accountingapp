-- Year-end close checklist. Auto items derive status live from the books; manual
-- items are checked off by the accountant and persisted here (per org + year).
CREATE TABLE IF NOT EXISTS year_end_close_items (
  id varchar PRIMARY KEY,
  organization_id varchar NOT NULL,
  year integer NOT NULL,
  item_key varchar NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  done_by_user_id varchar,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_yec_org_year_item ON year_end_close_items (organization_id, year, item_key);
