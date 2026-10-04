/**
 * Firm-scoped Affiliates page for pros / partners.
 * Route: /pro/affiliates — reached from the profile menu.
 */
import { Users } from "lucide-react";
import { useAuth } from "@/lib/auth";
import AffiliatesTable from "@/components/AffiliatesTable";

export default function ProAffiliates() {
  const { user } = useAuth();
  const isPartner = user?.role === "partner";
  return (
    <div className="max-w-6xl mx-auto py-8 space-y-6" data-testid="pro-affiliates-page">
      <div className="flex items-start gap-3">
        <Users className="text-emerald-600 mt-1" size={22} />
        <div>
          <h1 className="font-heading text-3xl font-semibold">Affiliates</h1>
          <p className="text-sm text-slate-500 mt-1">
            People promoting your {isPartner ? "partner" : "firm"} brand with a referral link — matched to you by your sign-in address slug — and what their links have produced.
          </p>
        </div>
      </div>
      <AffiliatesTable base="/firm/affiliates" showFirmColumn={false} />
    </div>
  );
}
