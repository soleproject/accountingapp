import CompanySettings from "@/pages/CompanySettings";

/**
 * AccountingSettings — /accounting/settings (Round 7.7, Feb 2026).
 * Accounting-scoped sub-page of Company Settings. Renders only the
 * five tabs relevant to bookkeeping workflows: Bookkeeping,
 * QuickBooks, Advanced Features, Report Styling, and Tours & Tips.
 * The User Settings, Profile, and Danger Zone tabs stay on the
 * platform-wide /settings page.
 */
const ACCOUNTING_TABS = [
  "bookkeeping",
  "quickbooks",
  "advanced",
  "report_style",
  "tours",
];

export default function AccountingSettings() {
  return (
    <div data-testid="accounting-settings-page">
      <CompanySettings
        allowedTabs={ACCOUNTING_TABS}
        title="Accounting Settings"
      />
    </div>
  );
}
