"""Pydantic request/response models shared across route modules.

Kept flat + focused on the *input* shapes accepted by the API. Persistence
schemas live in the collection-specific modules (accounts.py, transactions,
invoices, …); those are dictionaries because Motor gives us dicts anyway.
"""
from __future__ import annotations
from typing import Optional, List
from pydantic import BaseModel, EmailStr


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class SignupIn(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "client"
    # Optional affiliate referral slug — set on the user as
    # `referred_by_user_id` for later revenue-share crediting.
    ref: str | None = None
    # Enterprise (firm) name — only used when ``role='pro'`` on the
    # ``/signup/enterprise`` path. When provided, we auto-provision an
    # Enterprise record owned by the new Pro user right after signup
    # via ``enterprises.ensure_personal_enterprise_for_pro``. The
    # private-label subdomain is NOT collected here; that's a paid
    # upgrade in a later iteration.
    enterprise_name: str | None = None


class CompanyCreate(BaseModel):
    name: str
    business_type: str = ""
    business_description: str = ""
    reporting_basis: str = "accrual"
    # Region: "US" (default) or "UK". Phase 0 accepts the field but
    # every existing UI keeps sending nothing here → backend derives
    # US defaults, preserving today's behavior identically.
    region: Optional[str] = None


class TransactionUpdate(BaseModel):
    category_account_id: Optional[str] = None
    description: Optional[str] = None
    merchant: Optional[str] = None
    amount: Optional[float] = None
    date: Optional[str] = None
    bank_account_id: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = None
    needs_review: Optional[bool] = None
    human_reviewed: Optional[bool] = None
    posted: Optional[bool] = None
    splits: Optional[list] = None
    linked_invoice_id: Optional[str] = None
    linked_bill_id: Optional[str] = None
    tags: Optional[list] = None
    # Phase 2 advanced features — nullable, only populated when the
    # `classes_enabled` / `projects_enabled` company flag is on. Empty
    # string clears the field, `None` (default) leaves it untouched.
    class_id: Optional[str] = None
    project_id: Optional[str] = None
    phase_id: Optional[str] = None


class TransactionCreate(BaseModel):
    date: str
    description: str
    amount: float
    merchant: Optional[str] = ""
    bank_account_id: Optional[str] = None
    category_account_id: Optional[str] = None
    auto_categorize: bool = True
    # Optional split payload — if provided, the newly-created txn will
    # be stored with `splits` populated and marked human_reviewed=True so
    # it bypasses AI categorization entirely.
    splits: Optional[list] = None
    # Optional contact link — attached to the txn as `contact_id` +
    # denormalized `contact_name` so vendor rollups pick it up
    # immediately without a re-resolve pass.
    contact_id: Optional[str] = None
    contact_name: Optional[str] = None
    # Editor-authored fields — when a dedicated full-page editor
    # (Purchase / SalesReceipt / Deposit / CreditMemo / RefundReceipt)
    # submits a payload, it stamps `txn_type` explicitly so the mirror
    # qualifier doesn't have to guess. `line_items` carries the multi-
    # line detail (each with amount + category_account_id + description
    # and optional item_id) that a stat plain "amount/category" pair
    # can't express.
    txn_type: Optional[str] = None
    line_items: Optional[list] = None
    number: Optional[str] = None
    memo: Optional[str] = None
    notes: Optional[str] = None
    payment_type: Optional[str] = None
    # Credit Memo: link back to the original invoice being credited.
    linked_invoice_id: Optional[str] = None
    # Transfer: destination bank account id.
    transfer_to_account_id: Optional[str] = None


class SplitIn(BaseModel):
    splits: list  # [{amount, category_account_id, description}]


class RuleExtraCondition(BaseModel):
    """Additional AND/OR condition attached to a Rule (Tier-2, Mar 2026).

    field ∈ {"merchant", "description", "amount", "bank_account"}
    op    depends on field:
      - text fields  → contains | not_contains | starts_with | ends_with | equals
      - amount       → gt | lt | eq | between
      - bank_account → equals   (value is the account id)
    """
    field: str
    op: str
    value: Optional[str] = None       # accepts text OR string-encoded number
    value_2: Optional[float] = None   # upper bound when op="between"


class RuleSplit(BaseModel):
    """One slice of a multi-category split rule (Tier-3, Mar 2026).

    `percent` is expressed 0-100 (percent, not fraction). All slices
    on a rule must sum to 100. Splits are mutually exclusive with the
    top-level `account_code` — that becomes ignored when `splits`
    has any items.
    """
    account_code: str
    percent: float


class RuleCreate(BaseModel):
    match_type: str = "merchant_contains"
    # Primary condition field. "merchant" (default, back-compat) matches
    # `match_value` against the txn's merchant string. "contact" matches
    # `match_value` against the txn's `contact_id` (dropdown pick in the
    # UI — the value is the contact uuid, not a name).
    match_field: str = "merchant"          # "merchant" | "contact"
    match_value: str
    account_code: str
    account_name: Optional[str] = None
    apply_to_existing: bool = True
    # ---- Tier-1 QBO parity (Mar 2026) ------------------------------
    # Optional additional CONDITIONS on top of merchant match:
    bank_account_id: Optional[str] = None    # restrict to a single feed
    amount_op:       Optional[str] = None    # "gt"|"lt"|"eq"|"between"
    amount_value:    Optional[float] = None  # for gt / lt / eq / between-lower
    amount_value_2:  Optional[float] = None  # for between-upper
    # Transaction-type filter driven by the Withdrawal / Deposit / Both
    # pills in the Suggested-rule popup. "out" narrows the rule to
    # signed-negative rows (withdrawals), "in" narrows to positive rows
    # (deposits). Omit or set null to leave the rule direction-agnostic.
    direction:       Optional[str] = None    # "in" | "out" | None
    # Optional additional ACTIONS applied when the rule fires:
    contact_id:      Optional[str] = None    # tag payee alongside category
    # ---- Tier-2 QBO parity (Mar 2026) ------------------------------
    # Multi-condition builder — every extra row is joined with the
    # primary merchant match under either "all" (AND) or "any" (OR).
    extra_conditions: List[RuleExtraCondition] = []
    condition_logic:  str = "all"            # "all" | "any"
    class_id:         Optional[str] = None   # tag class alongside category
    tag_ids:          List[str] = []         # attach transaction tags
    posting_mode:     str = "auto"           # "auto" (post + skip review)
                                              # | "review" (flag for CPA)
    # ---- Tier-3 QBO parity (Mar 2026) ------------------------------
    enabled:          bool = True            # false → matcher skips this rule
    priority:         int  = 0               # highest priority wins ties
    splits:           List[RuleSplit] = []   # empty = normal single-account
                                              # non-empty = multi-category split
    # When True (default), retroactive `apply_to_existing` also sets
    # `human_reviewed=True` on every touched row so they land in the
    # Approved queue instead of the ambiguous "posted but not approved"
    # state. CPA can uncheck in the modal to keep the second-pass
    # review behaviour.
    mark_approved:    bool = True

class EstimateCreate(BaseModel):
    """Sales-cycle quote — a pre-invoice document sent to a
    customer for pricing approval. Structurally close to
    InvoiceCreate but with `expiration_date` instead of `due_date`
    and a different status vocabulary."""
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    expiration_date: Optional[str] = ""
    line_items: list
    tax: float = 0.0
    notes: Optional[str] = ""
    status: str = "draft"  # "draft" | "sent" | "accepted" | "rejected" | "closed"
    po_number: Optional[str] = ""
    shipping: float = 0.0
    discount: float = 0.0
    discount_type: Optional[str] = "amount"
    internal_notes: Optional[str] = ""
    attachments: Optional[list] = []
    title: Optional[str] = ""
    summary: Optional[str] = ""
    # Advanced-features FKs (nullable).
    class_id: Optional[str] = None
    project_id: Optional[str] = None
    phase_id: Optional[str] = None


class PurchaseOrderCreate(BaseModel):
    """Vendor-side pre-bill — a commitment to purchase. Structurally
    close to BillCreate but with a `status` vocabulary reflecting
    the fulfillment lifecycle rather than payment state."""
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    due_date: Optional[str] = ""
    line_items: list
    tax: float = 0.0
    notes: Optional[str] = ""
    status: str = "open"  # "open" | "closed" | "converted"
    internal_notes: Optional[str] = ""
    attachments: Optional[list] = []




class InvoiceCreate(BaseModel):
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    due_date: str
    line_items: list
    tax: float = 0.0
    notes: Optional[str] = ""
    status: str = "draft"
    # Feb 2026 — full-page editor fields.
    po_number: Optional[str] = ""
    terms: Optional[str] = ""          # "Due on receipt" | "Net 15" | "Net 30" | "Net 60" | "Custom"
    shipping: float = 0.0
    discount: float = 0.0              # value; interpretation controlled by discount_type
    discount_type: Optional[str] = "amount"  # "amount" | "percent"
    internal_notes: Optional[str] = ""       # never rendered on PDF
    attachments: Optional[list] = []         # [{filename, data_url, size}]
    # Wave-style header — optional per-invoice title and summary that
    # appear at the top of the PDF (below the logo). Title defaults to
    # "Invoice" if blank.
    title: Optional[str] = ""
    summary: Optional[str] = ""
    # Advanced-features FKs (nullable). Populated only when the
    # `classes_enabled` / `projects_enabled` company flag is on.
    class_id: Optional[str] = None
    project_id: Optional[str] = None
    phase_id: Optional[str] = None


class BillCreate(BaseModel):
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    due_date: str
    line_items: list
    tax: float = 0.0
    status: str = "open"
    notes: Optional[str] = ""
    # Feb 2026 — full-page bill editor parity with invoices.
    po_number: Optional[str] = ""
    terms: Optional[str] = ""
    shipping: float = 0.0
    discount: float = 0.0
    discount_type: Optional[str] = "amount"
    internal_notes: Optional[str] = ""
    attachments: Optional[list] = []
    title: Optional[str] = ""
    summary: Optional[str] = ""
    # Advanced-features FKs (nullable).
    class_id: Optional[str] = None
    project_id: Optional[str] = None
    phase_id: Optional[str] = None


class ContactCreate(BaseModel):
    name: str
    type: str = "customer"
    email: Optional[str] = ""
    phone: Optional[str] = ""
    address: Optional[str] = ""
    # Taxpayer ID (SSN, EIN, or ITIN) — plaintext on the wire, encrypted
    # at rest via `crypto_service`. Only ever returned to the client
    # as `tin_last4` for display. `is_1099_vendor` flags a contractor
    # for inclusion in the annual 1099 Summary report.
    tax_id: Optional[str] = None
    is_1099_vendor: bool = False
    w9_on_file: bool = False


class AccountCreate(BaseModel):
    code: str
    name: str
    type: str
    subtype: str = ""
    # Wave-style granular sub-type (e.g. "cash_and_bank",
    # "property_plant_equipment", "loan_and_line_of_credit"). Drives the
    # CoA sub-section grouping and the modal's conditional extra fields.
    detail_type: Optional[str] = ""
    # Optional parent for sub-account grouping (e.g. Utilities → Electric,
    # Phone, Water, Gas). One level deep only — enforced client-side.
    parent_account_id: Optional[str] = None
    # ── Fixed Asset auto-create fields ────────────────────────────────
    # When detail_type == "property_plant_equipment" AND these are set,
    # we call asset_service.create_fixed_asset() to spawn the register
    # row + acquisition JE + depreciation schedule alongside the CoA row.
    cost: Optional[float] = None
    purchase_date: Optional[str] = None       # ISO YYYY-MM-DD
    useful_life_years: Optional[float] = None
    salvage_value: Optional[float] = None
    asset_type: Optional[str] = None          # key from ASSET_TYPES
    # ── Loan auto-create fields ───────────────────────────────────────
    # When detail_type == "loan_and_line_of_credit" AND these are set,
    # we spawn the linked loans row so the Loans page mirrors the CoA.
    lender: Optional[str] = None
    principal: Optional[float] = None
    rate: Optional[float] = None
    term_months: Optional[int] = None
    start_date: Optional[str] = None


class JECreate(BaseModel):
    date: str
    memo: Optional[str] = ""
    lines: list  # [{account_id, debit, credit, description}]


class ChatIn(BaseModel):
    company_id: str
    session_id: Optional[str] = None
    message: str
    focused_transaction_id: Optional[str] = None
    focused_bucket: Optional[dict] = None
    # Guided fixed-asset creation — Feb 2026. Frontend hands off the modal's
    # current draft state (name, cost, funding sources so far) so the AI can
    # ask precise follow-ups AND emit a `create-fixed-asset` proposal when it
    # has enough info to prefill the modal.
    focused_new_asset: Optional[dict] = None
    terseness: Optional[str] = "balanced"  # "concise" | "balanced" | "detailed"


class OnboardingUpdate(BaseModel):
    step: Optional[int] = None
    answers: Optional[dict] = None
    complete: Optional[bool] = None


class PaymentCreate(BaseModel):
    date: str
    amount: float
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    method: str = "check"
    linked_invoice_id: Optional[str] = None
    linked_bill_id: Optional[str] = None
    bank_account_id: Optional[str] = None
    # Undeposited Funds two-step workflow: the local account id the
    # payment's cash side DRs (customer receipts) or CRs (vendor
    # payouts). If omitted for a direction='in' payment, `create_payment`
    # auto-fills the company's Undeposited Funds account so the BS
    # asset column reflects the held cash until a Bank Deposit sweeps
    # it into an actual bank account. Feb 28 2026.
    deposit_to_account_id: Optional[str] = None
    memo: Optional[str] = ""
    # Feb 2026 — Record-Payment modal can auto-fill from an existing
    # bank transaction. Setting this locks the payment to the txn so
    # cascade-delete stays honest.
    source_transaction_id: Optional[str] = None


class ReceiptCreate(BaseModel):
    date: str
    amount: float
    merchant: str
    # Optional contact link — when picked from the vendor dropdown, the
    # frontend passes both `contact_id` and denormalized `contact_name`
    # so vendor rollups pick it up without a re-resolve pass. `merchant`
    # stays populated (mirrors contact_name) for backwards-compat.
    contact_id: Optional[str] = None
    contact_name: Optional[str] = None
    category_account_id: Optional[str] = None
    notes: Optional[str] = ""
    # Payment source account — the bank/CC/cash the receipt was paid from.
    # Matches the "Account" dropdown on the Add-Manual-Transaction modal.
    payment_account_id: Optional[str] = None
    # Optional receipt image / PDF as a data-URL. Rendered inline on the
    # Receipts list and available for AI OCR downstream (Veryfi tie-in).
    attachment_data_url: Optional[str] = None
    attachment_filename: Optional[str] = None


class GenericCreate(BaseModel):
    data: dict


class NewClientIn(BaseModel):
    """Pro creates a new Client + company in one shot."""
    client_name: str
    client_email: EmailStr
    client_password: str = ""  # required only when the email is new
    company_name: str
    business_type: str = ""
    business_description: str = ""
    reporting_basis: str = "accrual"
    # Region defaults to None → backend resolves to US, matching pre-Phase-1
    # behavior byte-for-byte. Pros running UK books pass "UK" explicitly
    # from the New Client modal dropdown → backend seeds the FRS 102 CoA
    # and stamps `region: "UK"` on the company doc.
    region: Optional[str] = None
    # Phase B billing intent — persists on the resulting company doc so
    # Phase C's Stripe checkout knows which price to charge. All optional
    # for backwards-compat with any pre-billing modal.
    #   billing_payer:    client_email | client_card | enterprise | free_spot
    #   billing_product:  simple_start | essentials | plus | advanced
    #   billing_discount: applies the discounted price tier
    billing_payer: Optional[str] = None
    billing_product: Optional[str] = None
    billing_discount: Optional[bool] = None
    # Enterprise/pro can suppress the welcome / password-set email at
    # create time. Defaults to True so historical behaviour is preserved
    # (client gets the same welcome email as before). When False, no
    # welcome email is sent and the response reports `email_status =
    # "skipped_by_pro"` so the toast copy reflects the choice.
    send_welcome_email: bool = True
    # Superadmin-only: attribute the new client company to a specific
    # Partner (drives welcome-email branding via the existing
    # `company.partner_id -> partner.branding` cascade). Ignored when
    # the caller is themselves a Partner (their own id is used
    # instead). Round 7.18, Feb 2026.
    partner_id: Optional[str] = None
