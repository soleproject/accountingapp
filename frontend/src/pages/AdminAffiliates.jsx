/**
 * Superadmin > Affiliates — platform-wide affiliate directory.
 * Route: /admin/affiliates (superadmin only).
 */
import { Link } from "react-router-dom";
import { ChevronLeft, Users } from "lucide-react";
import AffiliatesTable from "@/components/AffiliatesTable";

export default function AdminAffiliates() {
  return (
    <div className="space-y-5" data-testid="admin-affiliates-page">
      <div className="flex items-center gap-3">
        <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800" data-testid="admin-affiliates-back">
          <ChevronLeft size={16} /> Superadmin
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <Users className="text-emerald-600" size={22} />
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Affiliates</h1>
          <p className="text-sm text-slate-500">Everyone sharing a referral link — which firm they promote, funnel counts, and what they've earned. Reassign a firm inline if a link is promoting the wrong brand.</p>
        </div>
      </div>
      <AffiliatesTable base="/admin/affiliates" canReassign showFirmColumn />
    </div>
  );
}
