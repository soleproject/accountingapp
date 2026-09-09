# Step 4: Check Register Review — Build Spec

**Status**: Design locked. Not started. Owner opted to defer implementation.

**Owner conversation date**: Feb 2026 (during 9-8-26-Test session)

---

## The problem this solves

In real-world Plaid connections, checks arrive from the bank feed as noisy strings like `"Check"`, `"Check 1013"`, or `"AUTOMATIC PAYMENT — REF 4712"` — no payee, often no merchant, just an amount and a reference number. The bookkeeper has to identify each check's payee from their physical checkbook / register (no check images available in most real-world data).

Owner explicitly said: *"In the future there will most likely not be a contact with the checks."* and *"We will most likely not have check images either."*

## Placement

**Step 4: Check Register Review** — its own top-level step, positioned after Step 3 (Intercompany Transfers) in the AI Cleanup Copilot header.

Ruled out during design:
- ~~Step 1b~~ — clean up too early, before AI categorization
- ~~Step 3c~~ — semantic mismatch (intercompany transfers ≠ outgoing checks to third parties)

Badge count: `{N} unresolved checks` — parallel to Step 3's "726 PAIRS" badge.

## Backend detection — `is_check_transaction()` helper

Cascading signals, most authoritative first:

1. `plaid_metadata.transaction_code == "check"` — Plaid's explicit flag
2. `plaid_metadata.payment_meta.reference_number` present on outgoing Plaid row
3. `raw.PaymentType == "Check"` — QBO-imported rows
4. Description regex: `^Check\s*#?\s*\d+\b` or `\bCK\s*#?\s*\d+\b`
5. `check_number` field if present (some ingest paths stamp this)
6. `txn_type == "Purchase"` + numeric `number` field — QBO-style

Verified against real data on Emerald Coast Pools & Spa LLC — 532 checks correctly detected via signals 3 + 6.

## Which checks need attention

Rows that:
- Match `is_check_transaction()` = true, AND
- Have `contact_id == None` OR `contact_name == ""` OR `not_a_check_reviewed != true`

## Endpoints

### `GET /companies/{cid}/checks/unassigned`
Returns paginated list. Response shape:
```
{
  "total": 47,
  "total_amount": 12340.00,
  "checks": [
    {
      "id": "txn-abc",
      "date": "2026-08-21",
      "number": "1013",
      "amount": -250.00,
      "memo": "...",
      "description": "Check 1013",
      "contact_id": null,
      "contact_name": "",
      "line_items": [],
      "category_account_id": null,
      "detection_signal": "plaid_transaction_code"
    },
    ...
  ]
}
```

### `POST /companies/{cid}/checks/{id}/assign`
Payload:
```
{
  "contact_id": "contact-xyz",         // or null + create_contact.name if new
  "create_contact": {"name": "..."},   // optional inline-create
  "line_items": [
    {"category_account_id": "acct-abc", "amount": 300, "description": "Materials"},
    {"category_account_id": "acct-def", "amount": 150, "description": "Tools"}
  ],
  "save_as_rule": false,                // Refinement A checkbox
  "mark_reviewed": true
}
```
Validator: sum of `line_items[*].amount` must equal `abs(txn.amount)`.

### `POST /companies/{cid}/checks/{id}/not-a-check`
Stamps `not_a_check_reviewed: true` on the row so future scans skip it. Idempotent, no other side effects.

## Frontend

New route: `/accounting/check-register-review`

### Table layout (locked)

| Check # ▲ | Payee (typeahead) | Categories & Amounts | Actions |
|---|---|---|---|
| 1013 | Nathan's Lawncare | Contractors $250.00 | Not a check |
| 1014 | Home Depot | Materials $300 / Tools $150 / Fuel $50 · Total $500 ✓ | Not a check |
| 1015 | ⚠ needs payee | (empty) | Not a check |

### Behaviors (locked)

- **Sort**: check number desc by default
- **Payee**: typeahead against `/contacts?type=vendor`, most-frequent-in-last-90-days at top of results, footer option `+ Create new payee` (calls `/contacts/ensure`)
- **Categories & Amounts**: compact single-line by default; click **Split** to expand to multi-line editor
- **Sum validator**: green ✓ when balanced, red ✗ when off (matches the check's absolute amount)
- **"Save as rule" checkbox** inline (Refinement A) — creates a payee→category rule via existing rules endpoint
- **"↑ Same as above" quick-fill** (Refinement B) — stamps prior row's payee + line structure onto current row
- **"Not a check" button** — right-side action, fires the `not-a-check` endpoint, row disappears
- **Keyboard-first**:
  - Tab moves between fields
  - ↓ moves to next check row
  - Enter saves the current row
  - ⌘K opens jump-by-check-number search

### Bulk operations

- Row checkboxes → toolbar: "Apply same payee to selected" / "Apply same category to selected" / "Mark selected as not a check"

## Data model changes

**Transaction schema additions**:
- `not_a_check_reviewed: bool` (default False)
- `check_review_completed_at: str | None` (ISO timestamp)

Everything else uses existing fields (`contact_id`, `contact_name`, `line_items[]`).

## Estimated build effort

Roughly **3 days of focused work**:
- Backend `is_check_transaction()` helper + tests: **½ day**
- GET/POST endpoints + validators: **½ day**
- Frontend table + payee typeahead + split editor: **1 day**
- Save-as-rule + Same-as-above + keyboard shortcuts + Not-a-check flow: **½ day**
- AI Cleanup Copilot header tile + routing + polish: **½ day**

## Ruled out during design (may revisit)

- **Check images** — Plaid returns them for some banks but owner confirmed real-world reality: usually not available. Skip.
- **AI vision recognition** of check images — depends on check images being available. Skip.
- **Nested substep of Step 3** — semantic mismatch with intercompany transfers. Made Step 4 top-level instead.

## Related files (as of Feb 2026)

- `/app/backend/routes/transactions.py` — where the new `checks/` endpoints will live (or a new `routes/checks.py`)
- `/app/backend/plaid_connect.py` — ingest path where `transaction_code` and `reference_number` are stamped
- `/app/backend/routes/contacts.py` — `contacts/ensure` endpoint reused for inline payee creation
- `/app/frontend/src/pages/AICleanupReview.jsx` — where the Step 4 tile will be added
- `/app/frontend/src/components/CleanupCopilot.jsx` — parent component for the review stepper
- `/app/frontend/src/components/SplitTransactionModal.jsx` — reference for split-line UX patterns to reuse
- `/app/frontend/src/components/ContactPicker.jsx` — reference for payee typeahead

## Verified real-world data (Emerald Coast Pools & Spa LLC preview)

- 4,368 total transactions
- 532 checks (`raw.PaymentType == "Check"`)
- 528 checks with payees, 4 without — because this is a QBO import
- No `plaid_metadata` on any row (no Plaid connection)
- All checks: `direction=out`, negative amounts, `number` field populated, most have `line_items` populated

Confirms the detection logic works. Real-world Plaid-only companies will have the opposite ratio (mostly missing payees).
