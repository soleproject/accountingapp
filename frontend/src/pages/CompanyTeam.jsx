/**
 * CompanyTeam — client-owner's team-management surface. Mirrors the
 * `ProTeam` page but scoped to a single company. Mounted at `/team` for
 * every role except Pro (Pros use `/pro/team` for firm-staff management).
 */
import TeamPanel from "@/components/TeamPanel";
import { useCompany } from "@/lib/company";
import { Users2 } from "lucide-react";

export default function CompanyTeam() {
  const { currentId, current } = useCompany();
  return (
    <div className="max-w-5xl px-6 py-6 space-y-6" data-testid="company-team-page">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-slate-900 flex items-center gap-2">
          <Users2 size={22} className="text-cyan-600" /> Team &amp; permissions
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl">
          Invite bookkeepers, external accountants, or staff onto
          <b> {current?.name || "your company"}</b>. Each teammate can be an
          Editor (post JEs, categorize, reconcile), a Reviewer (approve or
          reject entries), or a Viewer (read-only).
        </p>
      </div>
      {currentId && <TeamPanel mode="company" companyId={currentId} />}
    </div>
  );
}
