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
from routes.reconciliation import router as reconciliation_router  # noqa: F401
from routes.month_close import router as month_close_router  # noqa: F401
from routes.inventory import router as inventory_router  # noqa: F401
from routes.chat import router as chat_router  # noqa: F401
from routes.anomaly import router as anomaly_router  # noqa: F401
from routes.communications import router as communications_router  # noqa: F401
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
    reconciliation_router,
    month_close_router,
    inventory_router,
    chat_router,
    anomaly_router,
    communications_router,
    root_router,
]
