"""Help catalog — the 34-task knowledge base powering the "How do I / Where do I /
Can I / What is / Show me" assistant.

One row per capability. Each row is verb-agnostic: the same content serves
"how", "where", "can", "what", and "show" via templated rendering in the
backend classifier. That keeps the maintenance surface small (34 rows, not
170) while still answering every verb variant correctly.

Fields
------
id           canonical identifier; used as the classifier's return key
title        human-readable task label (used in headings)
aliases      lowercased phrases the classifier keyword-matches against
where        one-liner describing where in the UI (sidebar + subpage)
how          markdown numbered-list steps to complete the task
what         optional glossary answer for pure "what is X" questions
deep_link    URL to open when the user taps "Take me there"
action_tier  green | yellow | red — governs the "do it for me" button
             green   → button navigates & auto-opens the create modal
             yellow  → navigates then shows a confirm prompt
             red     → no auto-do button; navigate only (destructive actions)
action_hint  label for the "do it for me" button (falls back to title)

Notes
-----
The classifier prefers exact alias hits, then substring, then embedding-like
overlap. Ordering here doesn't affect matching quality — the alias fan-out
does. When adding a new task, list every phrase real users might type,
including short forms ("PO", "AP") and typos are OK to include.
"""
HELP_CATALOG = [
    # ============== BANK & QBO CONNECTIONS ==============
    {
        "id": "connect_bank",
        "title": "Connect a Bank Account (Plaid)",
        "aliases": ["connect bank", "connect my bank", "link bank", "add bank",
                    "connect a bank account", "plaid", "hook up bank",
                    "connect checking account"],
        "where": "Left sidebar → Connect & Import → Connect Accounts",
        "how": "1. Open **Connect & Import → Connect Accounts** in the sidebar.\n"
               "2. Click **+ Connect a bank** to launch Plaid Link.\n"
               "3. Search your bank, sign in, and pick which accounts to sync.\n"
               "4. Transactions from the last 90 days start streaming in automatically.",
        "deep_link": "/connections",
        "action_tier": "green",
        "action_hint": "Open Connect Accounts",
    },
    {
        "id": "connect_qbo",
        "title": "Connect QuickBooks Online",
        "aliases": ["connect qbo", "link qbo", "connect quickbooks",
                    "hook up quickbooks", "sync quickbooks", "qbo migration",
                    "import from quickbooks"],
        "where": "Left sidebar → Connect & Import → Connect QBO",
        "how": "1. Open **Connect & Import → Connect QBO** in the sidebar.\n"
               "2. Click **Connect to QuickBooks** — you'll be sent to Intuit to sign in.\n"
               "3. Grant access and you'll bounce back here.\n"
               "4. The full migration (accounts, txns, invoices, bills, GL) runs automatically. "
               "You can watch progress on the same page.",
        "deep_link": "/connections/qbo",
        "action_tier": "green",
        "action_hint": "Open Connect QBO",
    },
    {
        "id": "disconnect_bank",
        "title": "Disconnect a Bank or QBO",
        "aliases": ["disconnect bank", "unlink bank", "remove bank",
                    "disconnect qbo", "disconnect quickbooks",
                    "remove plaid", "unhook"],
        "where": "Left sidebar → Connect & Import → Connect Accounts (or Connect QBO) → the account row's ⋯ menu",
        "how": "1. Go to the connection page (Connect Accounts for banks, Connect QBO for QuickBooks).\n"
               "2. Click the **⋯ menu** on the connection you want to remove.\n"
               "3. Choose **Disconnect**. Historical transactions stay — future syncs stop.",
        "deep_link": "/connections",
        "action_tier": "red",
        "action_hint": None,  # destructive — navigate only
    },

    # ============== PURCHASES ==============
    {
        "id": "create_purchase_order",
        "title": "Create a Purchase Order",
        "aliases": ["purchase order", "po", "create po", "do a po",
                    "create purchase order", "new purchase order"],
        "where": "Left sidebar → Purchases → Purchase Orders → **+ New Purchase Order**",
        "how": "1. Go to **Purchases → Purchase Orders**.\n"
               "2. Click **+ New Purchase Order**.\n"
               "3. Pick a vendor, add line items with expected quantities and unit costs.\n"
               "4. Save as draft or Save & Send to email the vendor. POs are non-posted (no GL impact) until a bill is received against them.",
        "deep_link": "/purchase-orders/new",
        "action_tier": "yellow",
        "action_hint": "Draft a PO now",
    },
    {
        "id": "create_bill",
        "title": "Create a Bill",
        "aliases": ["create a bill", "do a bill", "enter bill", "new bill",
                    "add a bill", "record a bill", "vendor bill"],
        "where": "Left sidebar → Purchases → Bills → **+ New Bill**",
        "how": "1. Go to **Purchases → Bills**.\n"
               "2. Click **+ New Bill**.\n"
               "3. Pick the vendor, enter the bill date, due date, and line items with category accounts.\n"
               "4. Save. The bill posts to A/P as an unpaid liability until you record a Bill Payment against it.",
        "deep_link": "/bills/new",
        "action_tier": "yellow",
        "action_hint": "Draft a bill now",
    },
    {
        "id": "pay_bill",
        "title": "Pay a Bill",
        "aliases": ["pay a bill", "pay bill", "settle bill", "bill payment",
                    "record bill payment", "mark bill paid"],
        "where": "Left sidebar → Purchases → Bills → open a bill → **Pay Bill**",
        "how": "1. Go to **Purchases → Bills**.\n"
               "2. Open an unpaid bill.\n"
               "3. Click **Pay Bill**, pick the bank/CC account and the amount (partials allowed).\n"
               "4. Save — creates a Bill Payment, reduces A/P, and hits the paying account.",
        "deep_link": "/bills",
        "action_tier": "yellow",
        "action_hint": "Show me open bills",
    },

    # ============== SALES & PAYMENTS ==============
    {
        "id": "create_estimate",
        "title": "Create an Estimate",
        "aliases": ["estimate", "do an estimate", "create estimate",
                    "quote", "proposal", "new estimate"],
        "where": "Left sidebar → Sales & Payments → Estimates → **+ New Estimate**",
        "how": "1. Go to **Sales & Payments → Estimates**.\n"
               "2. Click **+ New Estimate**.\n"
               "3. Pick the customer, line items, and expiration date.\n"
               "4. Save & Send. Estimates are non-posted; you can convert them to an Invoice once accepted.",
        "deep_link": "/estimates/new",
        "action_tier": "yellow",
        "action_hint": "Draft an estimate now",
    },
    {
        "id": "create_invoice",
        "title": "Create an Invoice",
        "aliases": ["invoice", "do an invoice", "create an invoice",
                    "new invoice", "bill a customer", "send an invoice"],
        "where": "Left sidebar → Sales & Payments → Invoices → **+ New Invoice**",
        "how": "1. Go to **Sales & Payments → Invoices**.\n"
               "2. Click **+ New Invoice**.\n"
               "3. Pick the customer, line items (with income accounts), and payment terms.\n"
               "4. Save & Send emails a payment link the customer can click to pay.",
        "deep_link": "/invoices/new",
        "action_tier": "yellow",
        "action_hint": "Draft an invoice now",
    },
    {
        "id": "pay_invoice",
        "title": "Record a Payment on an Invoice",
        "aliases": ["pay an invoice", "pay invoice", "receive payment",
                    "record payment", "mark invoice paid", "collect payment"],
        "where": "Left sidebar → Sales & Payments → Invoices → open an invoice → **Receive Payment**",
        "how": "1. Go to **Sales & Payments → Invoices**.\n"
               "2. Open an unpaid invoice.\n"
               "3. Click **Receive Payment**, pick the deposit account and amount.\n"
               "4. Save — creates a Payment, reduces A/R, and increases cash.",
        "deep_link": "/invoices",
        "action_tier": "yellow",
        "action_hint": "Show me open invoices",
    },
    {
        "id": "create_recurring_invoice",
        "title": "Create a Recurring Invoice",
        "aliases": ["recurring invoice", "subscription invoice",
                    "auto-invoice", "monthly invoice", "recurring bill customer"],
        "where": "Left sidebar → Sales & Payments → Recurring → **+ New Recurring**",
        "how": "1. Go to **Sales & Payments → Recurring**.\n"
               "2. Click **+ New Recurring**.\n"
               "3. Pick the customer, line items, and cadence (weekly, monthly, quarterly, annual).\n"
               "4. Save. Axiom auto-creates and sends the invoice on the schedule.",
        "deep_link": "/recurring",
        "action_tier": "green",
        "action_hint": "Open Recurring",
    },

    # ============== INVENTORY ==============
    {
        "id": "enter_inventory",
        "title": "Enter or Adjust Inventory",
        "aliases": ["enter inventory", "adjust inventory", "inventory count",
                    "stock count", "inventory adjustment"],
        "where": "Left sidebar → Sales & Payments → Products & Services → open an item → **Adjust Quantity**",
        "how": "1. Go to **Sales & Payments → Products & Services**.\n"
               "2. Open the inventory item.\n"
               "3. Click **Adjust Quantity**, enter the new on-hand count and a reason.\n"
               "4. Save — creates an Inventory Adjustment journal entry.",
        "deep_link": "/items",
        "action_tier": "green",
        "action_hint": "Open Products & Services",
    },
    {
        "id": "create_inventory_item",
        "title": "Create an Inventory Item",
        "aliases": ["create inventory item", "new inventory item",
                    "add inventory item", "new product with quantity",
                    "add stock item"],
        "where": "Left sidebar → Sales & Payments → Products & Services → **+ New Item** → set Type to Inventory",
        "how": "1. Go to **Sales & Payments → Products & Services**.\n"
               "2. Click **+ New Item**.\n"
               "3. Choose **Inventory** as the type, set opening quantity, unit cost, and sales price.\n"
               "4. Save. Axiom will track quantity on-hand and average cost across every sale and purchase.",
        "deep_link": "/items",
        "action_tier": "green",
        "action_hint": "New inventory item",
    },
    {
        "id": "add_product",
        "title": "Add a Product or Service",
        "aliases": ["add product", "add service", "new product",
                    "add product / service", "create service item",
                    "new sales item"],
        "where": "Left sidebar → Sales & Payments → Products & Services → **+ New Item**",
        "how": "1. Go to **Sales & Payments → Products & Services**.\n"
               "2. Click **+ New Item**.\n"
               "3. Pick Service (non-inventory) or Non-Inventory or Inventory.\n"
               "4. Set name, sales price, and income account. Save.",
        "deep_link": "/items",
        "action_tier": "green",
        "action_hint": "New item",
    },

    # ============== RULES & CONTACTS ==============
    {
        "id": "create_rule",
        "title": "Create a Categorization Rule",
        "aliases": ["create a rule", "new rule", "auto-categorize",
                    "rule for merchant", "always categorize"],
        "where": "Left sidebar → Accounting → Rules → **+ New Rule**",
        "how": "1. Go to **Accounting → Rules**.\n"
               "2. Click **+ New Rule**.\n"
               "3. Enter the merchant substring (e.g. \"Starbucks\") and pick the category account.\n"
               "4. Check **Apply to existing** to backfill past unreviewed txns. Save.",
        "deep_link": "/accounting/rules",
        "action_tier": "green",
        "action_hint": "Open Rules",
    },
    {
        "id": "add_contact",
        "title": "Add a Contact (Customer or Vendor)",
        "aliases": ["add contact", "new contact", "add customer",
                    "add vendor", "create contact", "new vendor",
                    "new customer"],
        "where": "Left sidebar → Contacts → **+ New Contact**",
        "how": "1. Go to **Contacts**.\n"
               "2. Click **+ New Contact**.\n"
               "3. Enter name, email, phone, and pick a type (Customer, Vendor, Both, or leave untagged).\n"
               "4. Save.",
        "deep_link": "/contacts",
        "action_tier": "green",
        "action_hint": "New contact",
    },

    # ============== REPORTS ==============
    {
        "id": "run_pnl",
        "title": "Run a Profit & Loss Report",
        "aliases": ["run p&l", "profit and loss", "income statement",
                    "run income statement", "see my p&l", "see profit"],
        "where": "Left sidebar → Reports → Income Statement",
        "how": "1. Go to **Reports → Income Statement**.\n"
               "2. Pick the date range and basis (Cash or Accrual).\n"
               "3. Click a row to drill into the underlying transactions.\n"
               "4. Use the Compare panel to reconcile with QuickBooks (QBO-connected companies).",
        "deep_link": "/reports/income-statement",
        "action_tier": "green",
        "action_hint": "Open P&L",
    },
    {
        "id": "run_balance_sheet",
        "title": "Run a Balance Sheet Report",
        "aliases": ["balance sheet", "run balance sheet", "bs", "assets and liabilities"],
        "where": "Left sidebar → Reports → Balance Sheet",
        "how": "1. Go to **Reports → Balance Sheet**.\n"
               "2. Pick an as-of date and basis (Cash or Accrual).\n"
               "3. Drill into any account to see its detail. Compare panel available for QBO parity checks.",
        "deep_link": "/reports/balance-sheet",
        "action_tier": "green",
        "action_hint": "Open Balance Sheet",
    },
    {
        "id": "run_cash_flow",
        "title": "Run a Cash Flow Statement",
        "aliases": ["cash flow", "run cash flow", "statement of cash flows"],
        "where": "Left sidebar → Reports → Cash Flow",
        "how": "1. Go to **Reports → Cash Flow**.\n"
               "2. Pick the date range and basis.\n"
               "3. Sections split Operating / Investing / Financing. Numbers reconcile to Balance Sheet cash change.",
        "deep_link": "/reports/cash-flow",
        "action_tier": "green",
        "action_hint": "Open Cash Flow",
    },
    {
        "id": "run_gl",
        "title": "See the General Ledger",
        "aliases": ["general ledger", "gl", "run gl", "see gl for account",
                    "account detail", "transaction detail"],
        "where": "Left sidebar → Reports → General Ledger (or click any Balance Sheet / P&L row)",
        "how": "1. Go to **Reports → General Ledger**.\n"
               "2. Pick an account and date range.\n"
               "3. See every posting to that account with a running balance. Click a row to open the source transaction.",
        "deep_link": "/reports/general-ledger",
        "action_tier": "green",
        "action_hint": "Open General Ledger",
    },
    {
        "id": "reconcile_account",
        "title": "Reconcile a Bank Account",
        "aliases": ["reconcile", "reconcile account", "bank reconciliation",
                    "match bank statement", "reconciliation"],
        "where": "Left sidebar → Accounting → Reconciliation",
        "how": "1. Go to **Accounting → Reconciliation**.\n"
               "2. Pick the bank/CC account and statement end date.\n"
               "3. Enter the statement ending balance.\n"
               "4. Check off cleared items until the difference is $0. Finish to lock the period.",
        "deep_link": "/accounting/reconciliation",
        "action_tier": "green",
        "action_hint": "Open Reconciliation",
    },

    # ============== CLEANUP / CORRECTION ==============
    {
        "id": "recategorize_txn",
        "title": "Change a Transaction's Category or Contact",
        "aliases": ["recategorize", "change category", "fix category",
                    "change contact", "re-categorize transaction"],
        "where": "Left sidebar → Accounting → Transactions → click the row → edit inline",
        "how": "1. Go to **Accounting → Transactions**.\n"
               "2. Click the transaction row.\n"
               "3. Change the category or contact inline and click **Save**.\n"
               "4. Approving with the same merchant will teach Axiom's cache so future txns land right.",
        "deep_link": "/accounting/transactions",
        "action_tier": "green",
        "action_hint": "Open Transactions",
    },
    {
        "id": "delete_txn",
        "title": "Delete or Void a Transaction",
        "aliases": ["delete transaction", "void transaction",
                    "remove transaction", "undo transaction"],
        "where": "Left sidebar → Accounting → Transactions → row → **⋯ menu → Delete**",
        "how": "1. Go to **Accounting → Transactions**.\n"
               "2. Find the transaction and open the **⋯ menu**.\n"
               "3. Choose **Delete**. Delete is soft — the row is hidden but audit-logged.\n"
               "Note: deleting txns in a closed period is blocked.",
        "deep_link": "/accounting/transactions",
        "action_tier": "red",
        "action_hint": None,
    },
    {
        "id": "unapprove_txn",
        "title": "Undo an Approval",
        "aliases": ["unapprove", "undo approval", "mark for review",
                    "needs review again"],
        "where": "Left sidebar → Accounting → Transactions → row → **⋯ menu → Mark for review**",
        "how": "1. Go to **Accounting → Transactions**.\n"
               "2. Filter to Approved.\n"
               "3. Open the ⋯ menu on the row and choose **Mark for review**.",
        "deep_link": "/accounting/transactions?status=reviewed",
        "action_tier": "yellow",
        "action_hint": "Open Approved",
    },
    {
        "id": "upload_receipt",
        "title": "Upload / Attach a Receipt",
        "aliases": ["upload receipt", "attach receipt", "add receipt",
                    "scan receipt", "receipt to transaction"],
        "where": "Left sidebar → Receipts → **+ Upload receipt** (or drag onto a transaction row)",
        "how": "1. Go to **Receipts**.\n"
               "2. Click **+ Upload receipt** or drag a photo/PDF in.\n"
               "3. Veryfi OCRs the receipt and pre-fills the txn. Match it to an existing transaction or create a new one.",
        "deep_link": "/receipts",
        "action_tier": "green",
        "action_hint": "Open Receipts",
    },

    # ============== SETUP ==============
    {
        "id": "invite_teammate",
        "title": "Invite a Team Member or Partner",
        "aliases": ["invite team", "add user", "invite partner",
                    "add pro", "invite pro", "add teammate"],
        "where": "Left sidebar → Settings → Team",
        "how": "1. Go to **Settings → Team**.\n"
               "2. Click **+ Invite**, enter their email and pick a role (Pro, Client, Partner).\n"
               "3. They get an email with a set-password link.",
        "deep_link": "/team",
        "action_tier": "green",
        "action_hint": "Open Team",
    },
    {
        "id": "change_basis",
        "title": "Change Accounting Method (Cash / Accrual)",
        "aliases": ["change accounting method", "cash vs accrual",
                    "switch to cash", "switch to accrual", "reporting basis"],
        "where": "Left sidebar → Settings → Company → Reporting basis",
        "how": "This is a display default only — every report has a Cash / Accrual toggle. To change the default:\n"
               "1. Go to **Settings → Company**.\n"
               "2. Set **Reporting basis** to Cash or Accrual.\n"
               "3. Save. New report opens will default to that basis.",
        "deep_link": "/settings",
        "action_tier": "red",
        "action_hint": None,
    },
    {
        "id": "set_closing_date",
        "title": "Set a Books-Closing Date",
        "aliases": ["closing date", "close books", "close period",
                    "lock period", "set books closed"],
        "where": "Left sidebar → Settings → Company → Books closing date",
        "how": "1. Go to **Settings → Company**.\n"
               "2. Set **Books closing date** to the last day of your closed period.\n"
               "3. Transactions on/before that date are locked from editing (superadmin can still override).",
        "deep_link": "/settings",
        "action_tier": "red",
        "action_hint": None,
    },

    # ============== META ==============
    {
        "id": "what_can_you_do",
        "title": "What Can You Do?",
        "aliases": ["what can you do", "what can you help with",
                    "help", "menu", "capabilities", "features"],
        "where": None,
        "how": "I can help you with:\n"
               "• **Reports** — P&L, Balance Sheet, Cash Flow, General Ledger, Reconciliation\n"
               "• **Sales** — invoices, estimates, recurring invoices, receiving payments\n"
               "• **Purchases** — bills, purchase orders, bill payments\n"
               "• **Inventory** — creating items, adjusting quantities\n"
               "• **Setup** — connect Plaid or QBO, invite team, closing dates\n"
               "• **Cleanup** — recategorize, void, undo approvals, upload receipts\n"
               "• **Rules & Contacts** — categorization rules, add customers/vendors\n"
               "Ask me *how*, *where*, *can I*, *what is*, or *show me* for any of these.",
        "deep_link": None,
        "action_tier": None,
        "action_hint": None,
    },
    {
        "id": "glossary_cash_vs_accrual",
        "title": "Cash vs Accrual Basis",
        "aliases": ["what is cash basis", "cash basis vs accrual",
                    "what is accrual", "accrual basis",
                    "cash accounting", "accrual accounting"],
        "where": None,
        "what": "**Cash basis** counts revenue and expenses when money actually moves in or out of your bank. Simple, matches what your bank sees.\n\n"
                "**Accrual basis** counts revenue when earned (invoice sent) and expenses when incurred (bill received), regardless of when money moves. Matches GAAP and is required for larger businesses.\n\n"
                "Every Axiom report has a Cash / Accrual toggle so you can view either.",
        "how": None,
        "deep_link": "/reports/income-statement",
        "action_tier": "green",
        "action_hint": "See P&L (toggle basis)",
    },
    {
        "id": "glossary_reviewed",
        "title": "What Reviewed / Needs Review Means",
        "aliases": ["what is reviewed", "what does reviewed mean",
                    "needs review meaning", "human reviewed",
                    "reviewed 100"],
        "where": None,
        "what": "**Reviewed** = a human (or QBO's closing-date auto-approval) has confirmed the categorization is correct. Green chip.\n\n"
                "**Needs review** = the AI categorized it but flagged low confidence, OR nobody has manually approved it yet. Amber/rose chip.\n\n"
                "Approving a transaction teaches Axiom's per-org cache: the next transaction from the same merchant lands on the same category automatically.",
        "how": None,
        "deep_link": "/accounting/transactions",
        "action_tier": "green",
        "action_hint": "Open Transactions",
    },
    {
        "id": "glossary_drift",
        "title": "What is QBO Drift",
        "aliases": ["what is drift", "qbo drift", "what does drift mean",
                    "reconciliation drift"],
        "where": None,
        "what": "**Drift** = a difference between Axiom's report numbers and QuickBooks Online's numbers for the same account/date range.\n\n"
                "The Compare with QBO panel on any report shows drift per line. Common causes: transactions posted directly in QBO after last migration, closing entries QBO applied but Axiom hasn't pulled, or manual re-classifications on one side.\n\n"
                "Click **Refresh from QBO** on the Compare panel to fetch a fresh snapshot.",
        "how": None,
        "deep_link": "/reports/balance-sheet",
        "action_tier": "green",
        "action_hint": "Open Balance Sheet",
    },
]


HELP_INDEX = {t["id"]: t for t in HELP_CATALOG}
