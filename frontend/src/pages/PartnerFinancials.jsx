import SuperadminUsage from "@/pages/SuperadminUsage";

/**
 * Partner Financials — the Superadmin Usage & Costs page, scoped to the
 * current partner's tree of enterprises + companies. The heavy lifting
 * (chips / KPI cards / By Feature / All Cost Categories / etc.) lives
 * in `SuperadminUsage` — this file just points that component at the
 * partner-scoped endpoint and swaps the breadcrumb / title.
 *
 * The backend endpoint (`GET /partner/usage`) returns the same payload
 * shape but filters `ai_usage_events` by the partner's tree of company
 * ids (direct `companies.partner_id` OR attached to an enterprise the
 * partner owns), so partners never see platform-wide spend.
 */
export default function PartnerFinancials() {
  return (
    <SuperadminUsage
      endpoint="/partner/usage"
      title="Partner Financials"
      breadcrumb="Partner · Financials"
      testId="partner-financials-page"
    />
  );
}
