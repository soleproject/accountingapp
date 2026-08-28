"""Axiom Ledger — route modules (Feb 2026 modularization)."""

from routes.health_probes import router as health_probes_router  # noqa: F401
from routes.auth import router as auth_router  # noqa: F401
from routes.admin import router as admin_router  # noqa: F401
from routes.pro import router as pro_router  # noqa: F401
from routes.companies import router as companies_router  # noqa: F401
from routes.accounts import router as accounts_router  # noqa: F401
from routes.transactions import router as transactions_router  # noqa: F401
from routes.ai_ops import router as ai_ops_router  # noqa: F401
from routes.rules import router as rules_router  # noqa: F401
from routes.contacts import router as contacts_router  # noqa: F401
from routes.invoices import router as invoices_router  # noqa: F401
from routes.bills import router as bills_router  # noqa: F401
from routes.payments import router as payments_router  # noqa: F401
from routes.journal import router as journal_router  # noqa: F401
from routes.report_routes import router as report_routes_router  # noqa: F401
from routes.onboarding import router as onboarding_router  # noqa: F401
from routes.plaid import router as plaid_router  # noqa: F401
from routes.statements_routes import router as statements_routes_router  # noqa: F401
from routes.veryfi_webhooks import router as veryfi_webhooks_router  # noqa: F401
from routes.ai_first_routes import router as ai_first_router  # noqa: F401
from routes.reconciliation import router as reconciliation_router  # noqa: F401
from routes.month_close import router as month_close_router  # noqa: F401
from routes.inventory import router as inventory_router  # noqa: F401
from routes.chat import router as chat_router  # noqa: F401
from routes.insights_chat import router as insights_chat_router  # noqa: F401
from routes.marketing_pdf import router as marketing_pdf_router  # noqa: F401
from routes.anomaly import router as anomaly_router  # noqa: F401
from routes.communications import router as communications_router  # noqa: F401
from routes.invites import router as invites_router  # noqa: F401
from routes.stripe_billing import router as stripe_billing_router  # noqa: F401
from routes.firm_glance import router as firm_glance_router  # noqa: F401
from routes.recurring import router as recurring_router  # noqa: F401
from routes.items import router as items_router  # noqa: F401
from routes.qbo import router as qbo_router  # noqa: F401
from routes.qbo_mirror import router as qbo_mirror_router  # noqa: F401
from routes.qbo_test import router as qbo_test_router  # noqa: F401
from routes.estimates_pos import router as estimates_pos_router  # noqa: F401
from routes.audit_routes import router as audit_router  # noqa: F401
from routes.partners_routes import router as partners_router  # noqa: F401
from routes.feedback import router as feedback_router  # noqa: F401
from routes.feature_flags import router as feature_flags_router  # noqa: F401
from routes.public_demo import router as public_demo_router  # noqa: F401
from routes.help import router as help_router  # noqa: F401
from routes.leads import router as leads_router  # noqa: F401
from routes.classes import router as classes_router  # noqa: F401
from routes.projects import router as projects_router  # noqa: F401
from routes.budgets import router as budgets_router  # noqa: F401
from routes.tasks import router as tasks_router  # noqa: F401
from routes.employees import router as employees_router  # noqa: F401
from routes.notes import router as notes_router  # noqa: F401
from routes.time_entries import router as time_entries_router  # noqa: F401
from routes.team_calendar import router as team_calendar_router  # noqa: F401
from routes.search import router as search_router  # noqa: F401
from routes.deals import router as deals_router  # noqa: F401
from routes.crm_settings import router as crm_settings_router  # noqa: F401
from routes.home_dashboard import router as home_dashboard_router  # noqa: F401
from routes.root import router as root_router  # noqa: F401

ALL_ROUTERS = [
    health_probes_router,
    auth_router,
    admin_router,
    pro_router,
    companies_router,
    accounts_router,
    transactions_router,
    ai_ops_router,
    rules_router,
    contacts_router,
    invoices_router,
    bills_router,
    payments_router,
    journal_router,
    report_routes_router,
    onboarding_router,
    plaid_router,
    statements_routes_router,
    veryfi_webhooks_router,
    ai_first_router,
    reconciliation_router,
    month_close_router,
    inventory_router,
    chat_router,
    insights_chat_router,
    marketing_pdf_router,
    anomaly_router,
    communications_router,
    invites_router,
    stripe_billing_router,
    firm_glance_router,
    recurring_router,
    items_router,
    qbo_router,
    qbo_mirror_router,
    qbo_test_router,
    estimates_pos_router,
    audit_router,
    partners_router,
    feedback_router,
    feature_flags_router,
    public_demo_router,
    help_router,
    leads_router,
    classes_router,
    projects_router,
    budgets_router,
    tasks_router,
    employees_router,
    notes_router,
    time_entries_router,
    team_calendar_router,
    search_router,
    deals_router,
    crm_settings_router,
    home_dashboard_router,
    root_router,
]
