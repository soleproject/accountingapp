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


class CompanyCreate(BaseModel):
    name: str
    business_type: str = ""
    business_description: str = ""
    reporting_basis: str = "accrual"


class TransactionUpdate(BaseModel):
    category_account_id: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    date: Optional[str] = None
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


class BillCreate(BaseModel):
    number: Optional[str] = None
    contact_id: Optional[str] = None
    contact_name: Optional[str] = ""
    issue_date: str
    due_date: str
    line_items: list
    tax: float = 0.0
    status: str = "open"


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
    category_account_id: Optional[str] = None
    notes: Optional[str] = ""


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
