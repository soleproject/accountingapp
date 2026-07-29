/**
 * ProTeam — Pro's firm-staff management surface. Lists staff currently
 * with pro-membership on any of the Pro's clients, plus any pending
 * invites they've sent. New invites let the Pro pick a subset of their
 * clients per invitee.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import TeamPanel from "@/components/TeamPanel";
import { Users2 } from "lucide-react";

export default function ProTeam() {
  const [clients, setClients] = useState([]);
  // The Firm staff page is company-scoped when a client is picked in the
  // sidebar selector — so pending invites and staff show up correctly
  // even for superadmins (who have no personal pro memberships) and
  // survive refresh regardless of who created the invite.
  const { currentId, current } = useCompany();
  useEffect(() => {
    api.get("/pro/clients").then((r) => setClients(r.data?.clients || []));
  }, []);

  return (
    <div className="max-w-5xl px-6 py-6 space-y-6" data-testid="pro-team-page">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-slate-900 flex items-center gap-2">
          <Users2 size={22} className="text-cyan-600" /> Firm staff
        </h1>
        <p className="text-sm text-slate-600 mt-1 max-w-2xl">
          {currentId && current
            ? <>Staff and pending invites for <span className="font-medium text-slate-800">{current.name}</span>. Switch companies in the top selector to view another firm.</>
            : <>Invite junior accountants, bookkeepers, or partners onto your firm. Pick which client companies each invitee should have access to — you can always add or remove them per-client later.</>
          }
        </p>
      </div>

      <TeamPanel
        mode="pro"
        companyId={currentId || null}
        availableCompanies={clients}
      />
    </div>
  );
}
