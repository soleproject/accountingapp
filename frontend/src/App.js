import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "@/lib/auth";
import { CompanyProvider } from "@/lib/company";
import { BrandingProvider } from "@/lib/branding";
import { useHostTitle } from "@/lib/useHostTitle";
import { initPwa } from "@/lib/pwa";
import { InstallPromptToast } from "@/components/InstallPrompt";
import Layout from "@/components/Layout";
import VoiceActionReview from "@/components/VoiceActionReview";
import VoiceRecapReview from "@/components/VoiceRecapReview";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import EnterReferral from "@/pages/EnterReferral";
import ReferClickThru from "@/pages/ReferClickThru";
import Share from "@/pages/Share";
import PublicDemoUK from "@/pages/PublicDemoUK";
import Dashboard from "@/pages/Dashboard";
import Transactions from "@/pages/Transactions";
import AICleanupReview from "@/pages/AICleanupReview";
import LetsReview from "@/pages/LetsReview";
import NoContactReview from "@/pages/NoContactReview";
import TransferReview from "@/pages/TransferReview";
import Reports from "@/pages/Reports";
import ReportView from "@/pages/ReportView";
import ChartOfAccounts from "@/pages/ChartOfAccounts";
import Classes from "@/pages/Classes";
import Projects from "@/pages/Projects";
import ProjectsDashboard from "@/pages/ProjectsDashboard";
import ProjectDetail from "@/pages/ProjectDetail";
import Budgets from "@/pages/Budgets";
import BudgetEditor from "@/pages/BudgetEditor";
import BudgetVsActuals from "@/pages/BudgetVsActuals";
import EstimatesVsActuals from "@/pages/EstimatesVsActuals";
import CrmOverview from "@/pages/CrmOverview";
import CrmEmail from "@/pages/CrmEmail";
import CrmCalendar from "@/pages/CrmCalendar";
import HomeDashboard from "@/pages/HomeDashboard";
import DealsBoard from "@/pages/DealsBoard";
import CrmSettings from "@/pages/CrmSettings";
import Team from "@/pages/Team";
import TimeLog from "@/pages/TimeLog";
import TeamCalendar from "@/pages/TeamCalendar";
import TimesheetApprovals from "@/pages/TimesheetApprovals";
import JournalEntries from "@/pages/JournalEntries";
import PrintChecks from "@/pages/PrintChecks";
import NotificationSettings from "@/pages/NotificationSettings";
import Rules from "@/pages/Rules";
import Onboarding from "@/pages/Onboarding";
import SuperadminDash from "@/pages/SuperadminDash";
import SuperadminUsage from "@/pages/SuperadminUsage";
import SuperadminStripeWebhooks from "@/pages/SuperadminStripeWebhooks";
import AdminQboGlLab from "@/pages/AdminQboGlLab";
import PartnerDash from "@/pages/PartnerDash";
import PartnerFinancials from "@/pages/PartnerFinancials";
import AdminPartnerDetail from "@/pages/AdminPartnerDetail";
import ProClients from "@/pages/ProClients";
import AdminEnterpriseDetail from "@/pages/AdminEnterpriseDetail";
import AdminFeedback from "@/pages/AdminFeedback";
import AdminLeads from "@/pages/AdminLeads";
import MyFeedback from "@/pages/MyFeedback";
import { BillingSuccess, BillingCancel } from "@/pages/BillingReturn";
import Invoices from "@/pages/Invoices";
import Estimates from "@/pages/Estimates";
import EstimateEditor from "@/pages/EstimateEditor";
import PurchaseOrders from "@/pages/PurchaseOrders";
import PurchaseOrderEditor from "@/pages/PurchaseOrderEditor";
import InvoiceEditor from "@/pages/InvoiceEditor";
import Bills from "@/pages/Bills";
import BillEditor from "@/pages/BillEditor";
import PurchaseEditor from "@/pages/PurchaseEditor";
import SalesReceiptEditor from "@/pages/SalesReceiptEditor";
import DepositEditor from "@/pages/DepositEditor";
import CreditMemoEditor from "@/pages/CreditMemoEditor";
import RefundReceiptEditor from "@/pages/RefundReceiptEditor";
import SalesReceipts from "@/pages/SalesReceipts";
import CreditMemos from "@/pages/CreditMemos";
import BankMatchReview from "@/pages/BankMatchReview";
import AdvancedModeRoute from "@/components/AdvancedModeRoute";
import TaxLibrary from "@/pages/TaxLibrary";
import Recurring from "@/pages/Recurring";
import Items from "@/pages/Items";
import InventoryPage from "@/pages/InventoryPage";
import SalesReports from "@/pages/SalesReports";
import Payments from "@/pages/Payments";
import Receipts from "@/pages/Receipts";
import Contacts from "@/pages/Contacts";
import CustomerStatements from "@/pages/CustomerStatements";
import LoansPage from "@/pages/LoansPage";
import Connections from "@/pages/Connections";
import QboConnect from "@/pages/QboConnect";
import QboMirror from "@/pages/QboMirror";
import TestQbo from "@/pages/TestQbo";
import VendorCredits from "@/pages/VendorCredits";
import RefundReceipts from "@/pages/RefundReceipts";
import SalesTax from "@/pages/SalesTax";
import PfcCategoryMap from "@/pages/PfcCategoryMap";
import StatementImportDetail from "@/pages/StatementImportDetail";
import CompanySettings from "@/pages/CompanySettings";
import AccountingSettings from "@/pages/AccountingSettings";
import ProductGuard from "@/components/ProductGuard";
import AdminProductLaunches from "@/pages/AdminProductLaunches";
import CompletedActions from "@/pages/CompletedActions";
import PublicBookingPage from "@/pages/PublicBookingPage";
import AuditLog from "@/pages/AuditLog";
import ProSettings from "@/pages/ProSettings";
import MonthClose from "@/pages/MonthClose";
import MyBusinesses from "@/pages/MyBusinesses";
import Billing from "@/pages/Billing";
import Communications from "@/pages/Communications";
import AskClientAnswer from "@/pages/AskClientAnswer";
import SetPassword from "@/pages/SetPassword";
import AcceptInvite from "@/pages/AcceptInvite";
import ProTeam from "@/pages/ProTeam";
import CompanyTeam from "@/pages/CompanyTeam";
import GenericList from "@/pages/GenericList";
import FixedAssetsPage from "@/pages/FixedAssetsPage";
import GeneralLedger from "@/pages/GeneralLedger";
import Reconciliation from "@/pages/Reconciliation";
import ReconciliationDetail from "@/pages/ReconciliationDetail";
import BookReview from "@/pages/BookReview";
import ClosePeriods from "@/pages/ClosePeriods";

function Protected({ children }) {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  // Affiliate-only accounts see the Refer & earn page and nothing
  // else. Any deep-link into a client/pro surface bounces to /share.
  // The Layout component reads the same role and hides the sidebar.
  if (user.role === "affiliate" && pathname !== "/share") {
    return <Navigate to="/share" replace />;
  }
  return children;
}

// Sits inside BrandingProvider so the hook can read the signed-in user's
// firm branding. Renders nothing — its only job is to keep document.title
// in sync with the current host + logged-in firm.
function HostTitle() { useHostTitle(); return null; }

function App() {
  useEffect(() => { initPwa(); }, []);
  return (
    <BrowserRouter>
      <AuthProvider>
        <CompanyProvider>
          <BrandingProvider>
            <HostTitle />
            <InstallPromptToast />
            <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/book/:slug" element={<PublicBookingPage />} />
            <Route path="/demo/uk" element={<PublicDemoUK />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/signup/affiliate" element={<Signup />} />
            <Route path="/signup/enterprise" element={<Signup />} />
            <Route path="/refer" element={<EnterReferral />} />
            <Route path="/refer/:slug" element={<EnterReferral />} />
            <Route path="/r/:slug" element={<ReferClickThru />} />
            <Route path="/set-password/:token" element={<SetPassword />} />
            <Route path="/invite/:token" element={<AcceptInvite />} />
            <Route path="/q/:token" element={<AskClientAnswer />} />
            <Route path="/billing/success" element={<BillingSuccess />} />
            <Route path="/billing/cancel" element={<BillingCancel />} />
            <Route element={<Protected><Layout /></Protected>}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<ProductGuard product="accounting"><Dashboard /></ProductGuard>} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/admin" element={<SuperadminDash />} />
              <Route path="/admin/usage" element={<SuperadminUsage />} />
              <Route path="/admin/stripe-webhooks" element={<SuperadminStripeWebhooks />} />
              <Route path="/admin/qbo-gl-lab" element={<AdminQboGlLab />} />
              <Route path="/partner" element={<PartnerDash />} />
              <Route path="/partner/financials" element={<PartnerFinancials />} />
              <Route path="/admin/partners/:pid" element={<AdminPartnerDetail />} />
              <Route path="/admin/enterprises/:eid" element={<AdminEnterpriseDetail />} />
              <Route path="/admin/feedback" element={<AdminFeedback />} />
              <Route path="/admin/leads" element={<AdminLeads />} />
              <Route path="/feedback/mine" element={<MyFeedback />} />
              <Route path="/pro/clients" element={<ProClients />} />
              <Route path="/invoices" element={<Invoices />} />
              <Route path="/estimates" element={<Estimates />} />
              <Route path="/estimates/new" element={<EstimateEditor />} />
              <Route path="/estimates/:id/edit" element={<EstimateEditor />} />
              <Route path="/purchase-orders" element={<PurchaseOrders />} />
              <Route path="/purchase-orders/new" element={<PurchaseOrderEditor />} />
              <Route path="/purchase-orders/:id/edit" element={<PurchaseOrderEditor />} />
              <Route path="/invoices/new" element={<InvoiceEditor />} />
              <Route path="/invoices/:id/edit" element={<InvoiceEditor />} />
              <Route path="/bills" element={<Bills />} />
              <Route path="/bills/new" element={<BillEditor />} />
              <Route path="/bills/:id/edit" element={<BillEditor />} />
              <Route path="/purchases/new" element={<AdvancedModeRoute><PurchaseEditor /></AdvancedModeRoute>} />
              <Route path="/purchases/:id/edit" element={<AdvancedModeRoute><PurchaseEditor /></AdvancedModeRoute>} />
              <Route path="/sales-receipts/new" element={<AdvancedModeRoute><SalesReceiptEditor /></AdvancedModeRoute>} />
              <Route path="/sales-receipts/:id/edit" element={<AdvancedModeRoute><SalesReceiptEditor /></AdvancedModeRoute>} />
              <Route path="/sales-receipts" element={<AdvancedModeRoute><SalesReceipts /></AdvancedModeRoute>} />
              <Route path="/deposits/new" element={<AdvancedModeRoute><DepositEditor /></AdvancedModeRoute>} />
              <Route path="/deposits/:id/edit" element={<AdvancedModeRoute><DepositEditor /></AdvancedModeRoute>} />
              <Route path="/credit-memos/new" element={<AdvancedModeRoute><CreditMemoEditor /></AdvancedModeRoute>} />
              <Route path="/credit-memos/:id/edit" element={<AdvancedModeRoute><CreditMemoEditor /></AdvancedModeRoute>} />
              <Route path="/credit-memos" element={<AdvancedModeRoute><CreditMemos /></AdvancedModeRoute>} />
              <Route path="/refund-receipts/new" element={<AdvancedModeRoute><RefundReceiptEditor /></AdvancedModeRoute>} />
              <Route path="/refund-receipts/:id/edit" element={<AdvancedModeRoute><RefundReceiptEditor /></AdvancedModeRoute>} />
              <Route path="/accounting/bank-matches" element={<AdvancedModeRoute><BankMatchReview /></AdvancedModeRoute>} />
              <Route path="/recurring" element={<Recurring />} />
              <Route path="/items" element={<Items />} />
              <Route path="/inventory-management" element={<InventoryPage />} />
              <Route path="/sales-reports" element={<SalesReports />} />
              <Route path="/payments" element={<Payments />} />
              <Route path="/receipts" element={<Receipts />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/contacts/:contactId" element={<Contacts />} />
              <Route path="/customer-statements" element={<CustomerStatements />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/connections/qbo" element={<QboConnect />} />
              <Route path="/test-qbo" element={<TestQbo />} />
              <Route path="/vendor-credits" element={<VendorCredits />} />
              <Route path="/refund-receipts" element={<RefundReceipts />} />
              <Route path="/accounting/sales-tax" element={<SalesTax />} />
              <Route path="/settings/qbo-mirror" element={<QboMirror />} />
              <Route path="/settings/pfc-map" element={<PfcCategoryMap />} />
              <Route path="/settings/notifications" element={<NotificationSettings />} />
              <Route path="/connections/imports/:importId" element={<StatementImportDetail />} />
              <Route path="/settings" element={<CompanySettings allowedTabs={["user", "profile", "danger"]} />} />
              <Route path="/completed-actions" element={<CompletedActions />} />
              <Route path="/audit-log" element={<AuditLog />} />
              <Route path="/pro/settings" element={<ProSettings />} />
              <Route path="/pro/team" element={<ProTeam />} />
              <Route path="/company-team" element={<CompanyTeam />} />
              <Route path="/communications" element={<Communications />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/reports/:kind" element={<ReportView />} />
              <Route path="/accounting/transactions" element={<Transactions />} />
              <Route path="/accounting/ai-cleanup-review" element={<AICleanupReview />} />
              <Route path="/accounting/lets-review" element={<LetsReview />} />
              <Route path="/accounting/no-contact-review" element={<NoContactReview />} />
              <Route path="/accounting/transfer-review" element={<TransferReview />} />
              <Route path="/accounting/inventory" element={<GenericList
                path="inventory" title="Inventory"
                fields={[{k:"name",l:"Item Name"},{k:"sku",l:"SKU"},{k:"quantity",l:"Qty",t:"number"},{k:"unit_cost",l:"Unit Cost",t:"number"}]}
              />} />
              <Route path="/accounting/assets" element={<FixedAssetsPage />} />
              <Route path="/accounting/loans" element={<LoansPage />} />
              <Route path="/accounting/tags" element={<GenericList
                path="tags" title="Tags"
                fields={[{k:"name",l:"Tag"},{k:"description",l:"Description"}]}
              />} />
              <Route path="/accounting/reconciliation" element={<Reconciliation />} />
              <Route path="/accounting/reconciliation/:rid" element={<ReconciliationDetail />} />
              <Route path="/accounting/book-review" element={<BookReview />} />
              <Route path="/accounting/close-books" element={<ClosePeriods kind="month" />} />
              <Route path="/accounting/month-close" element={<MonthClose />} />
              <Route path="/my-businesses" element={<MyBusinesses />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/share" element={<Share />} />
              <Route path="/accounting/year-end" element={<ClosePeriods kind="year" />} />
              <Route path="/accounting/chart-of-accounts" element={<ChartOfAccounts />} />
              <Route path="/accounting/classes" element={<Classes />} />
              <Route path="/accounting/projects" element={<ProductGuard product="projects"><ProjectsDashboard /></ProductGuard>} />
              <Route path="/accounting/projects/list" element={<Projects />} />
              <Route path="/accounting/projects/:projectId" element={<ProjectDetail />} />
              <Route path="/accounting/budgets" element={<Budgets />} />
              <Route path="/accounting/budgets/:budgetId" element={<BudgetEditor />} />
              <Route path="/crm" element={<ProductGuard product="crm"><CrmOverview /></ProductGuard>} />
              <Route path="/home" element={<ProductGuard product="home"><HomeDashboard /></ProductGuard>} />
              <Route path="/crm/deals" element={<DealsBoard />} />
              <Route path="/crm/email" element={<CrmEmail />} />
              <Route path="/crm/calendar" element={<CrmCalendar />} />
              <Route path="/crm/settings" element={<CrmSettings />} />
              <Route path="/accounting/settings" element={<AccountingSettings />} />
              <Route path="/admin/product-launches" element={<AdminProductLaunches />} />
              <Route path="/team" element={<ProductGuard product="team"><Team /></ProductGuard>} />
              <Route path="/team/time" element={<TimeLog />} />
              <Route path="/team/calendar" element={<TeamCalendar />} />
              <Route path="/team/approvals" element={<TimesheetApprovals />} />
              <Route path="/reports/budget-vs-actuals" element={<BudgetVsActuals />} />
              <Route path="/reports/estimates-vs-actuals" element={<EstimatesVsActuals />} />
              <Route path="/accounting/journal-entries" element={<JournalEntries />} />
              <Route path="/accounting/checks" element={<PrintChecks />} />
              <Route path="/accounting/general-ledger" element={<GeneralLedger />} />
              <Route path="/accounting/rules" element={<Rules />} />
              <Route path="/accounting/taxes" element={<TaxLibrary />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          <VoiceActionReview />
          <VoiceRecapReview />
          </BrandingProvider>
        </CompanyProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
