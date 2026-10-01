import CompanySettings from "@/pages/CompanySettings";

/**
 * AccountingSettings — /accounting/settings (Round 7.7, Feb 2026).
 * Company-scoped settings. Holds every per-company tab: Bookkeeping,
 * Profile, Advanced Features, Report Styling, Tours & Tips,
 * QuickBooks, Notifications & Mobile App, Danger Zone. Only the
 * per-user "User Settings" tab stays on the platform-wide /settings.
 */
const ACCOUNTING_TABS = [
  "bookkeeping",
  "profile",
  "advanced",
  "report_style",
  "tours",
  "quickbooks",
  "notifications",
  "danger",
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
