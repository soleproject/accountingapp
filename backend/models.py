"""Pydantic request/response models shared across route modules.

Kept flat + focused on the *input* shapes accepted by the API. Persistence
schemas live in the collection-specific modules (accounts.py, transactions,
invoices, …); those are dictionaries because Motor gives us dicts anyway.
"""
from __future__ import annotations
from typing import Optional
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


class SplitIn(BaseModel):
    splits: list  # [{amount, category_account_id, description}]


class RuleCreate(BaseModel):
    match_type: str = "merchant_contains"
    match_value: str
    account_code: str
    account_name: Optional[str] = None
    apply_to_existing: bool = True


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


class ContactCreate(BaseModel):
    name: str
    type: str = "customer"
    email: Optional[str] = ""
    phone: Optional[str] = ""
    address: Optional[str] = ""


class AccountCreate(BaseModel):
    code: str
    name: str
    type: str
    subtype: str = ""
    # Optional parent for sub-account grouping (e.g. Utilities → Electric,
    # Phone, Water, Gas). One level deep only — enforced client-side.
    parent_account_id: Optional[str] = None


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
    memo: Optional[str] = ""


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
    # Phase B billing intent — persists on the resulting company doc so
    # Phase C's Stripe checkout knows which price to charge. All optional
    # for backwards-compat with any pre-billing modal.
    #   billing_payer:    client_email | client_card | enterprise | free_spot
    #   billing_product:  simple_start | essentials | plus | advanced
    #   billing_discount: applies the discounted price tier
    billing_payer: Optional[str] = None
    billing_product: Optional[str] = None
    billing_discount: Optional[bool] = None
