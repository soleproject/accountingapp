import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { CompanyProvider } from "@/lib/company";
import { BrandingProvider } from "@/lib/branding";
import { useHostTitle } from "@/lib/useHostTitle";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Signup from "@/pages/Signup";
import Share from "@/pages/Share";
import Dashboard from "@/pages/Dashboard";
import Transactions from "@/pages/Transactions";
import Reports from "@/pages/Reports";
import ReportView from "@/pages/ReportView";
import ChartOfAccounts from "@/pages/ChartOfAccounts";
import JournalEntries from "@/pages/JournalEntries";
import Rules from "@/pages/Rules";
import Onboarding from "@/pages/Onboarding";
import SuperadminDash from "@/pages/SuperadminDash";
import SuperadminUsage from "@/pages/SuperadminUsage";
import ProClients from "@/pages/ProClients";
import Invoices from "@/pages/Invoices";
import Bills from "@/pages/Bills";
import Payments from "@/pages/Payments";
import Receipts from "@/pages/Receipts";
import Contacts from "@/pages/Contacts";
import Connections from "@/pages/Connections";
import StatementImportDetail from "@/pages/StatementImportDetail";
import CompanySettings from "@/pages/CompanySettings";
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
import GeneralLedger from "@/pages/GeneralLedger";
import Reconciliation from "@/pages/Reconciliation";
import ReconciliationDetail from "@/pages/ReconciliationDetail";
import BookReview from "@/pages/BookReview";
import ClosePeriods from "@/pages/ClosePeriods";

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

// Sits inside BrandingProvider so the hook can read the signed-in user's
// firm branding. Renders nothing — its only job is to keep document.title
// in sync with the current host + logged-in firm.
function HostTitle() { useHostTitle(); return null; }

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <CompanyProvider>
          <BrandingProvider>
            <HostTitle />
            <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/set-password/:token" element={<SetPassword />} />
            <Route path="/invite/:token" element={<AcceptInvite />} />
            <Route path="/q/:token" element={<AskClientAnswer />} />
            <Route element={<Protected><Layout /></Protected>}>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/admin" element={<SuperadminDash />} />
              <Route path="/admin/usage" element={<SuperadminUsage />} />
              <Route path="/pro/clients" element={<ProClients />} />
              <Route path="/invoices" element={<Invoices />} />
              <Route path="/bills" element={<Bills />} />
              <Route path="/payments" element={<Payments />} />
              <Route path="/receipts" element={<Receipts />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/connections/imports/:importId" element={<StatementImportDetail />} />
              <Route path="/settings" element={<CompanySettings />} />
              <Route path="/pro/settings" element={<ProSettings />} />
              <Route path="/pro/team" element={<ProTeam />} />
              <Route path="/team" element={<CompanyTeam />} />
              <Route path="/communications" element={<Communications />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/reports/:kind" element={<ReportView />} />
              <Route path="/accounting/transactions" element={<Transactions />} />
              <Route path="/accounting/inventory" element={<GenericList
                path="inventory" title="Inventory"
                fields={[{k:"name",l:"Item Name"},{k:"sku",l:"SKU"},{k:"quantity",l:"Qty",t:"number"},{k:"unit_cost",l:"Unit Cost",t:"number"}]}
              />} />
              <Route path="/accounting/assets" element={<GenericList
                path="assets" title="Fixed Assets"
                fields={[{k:"name",l:"Asset"},{k:"purchase_date",l:"Purchased",t:"date"},{k:"cost",l:"Cost",t:"number"},{k:"useful_life_years",l:"Life (yrs)",t:"number"}]}
              />} />
              <Route path="/accounting/loans" element={<GenericList
                path="loans" title="Loans"
                fields={[{k:"lender",l:"Lender"},{k:"principal",l:"Principal",t:"number"},{k:"rate",l:"Interest Rate %",t:"number"},{k:"term_months",l:"Term (months)",t:"number"}]}
              />} />
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
              <Route path="/accounting/journal-entries" element={<JournalEntries />} />
              <Route path="/accounting/general-ledger" element={<GeneralLedger />} />
              <Route path="/accounting/rules" element={<Rules />} />
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </BrandingProvider>
        </CompanyProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
