import { useLocation } from "react-router-dom";
import { ShieldOff } from "lucide-react";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { usePracticePerms, featureForPath } from "@/components/practice/perms";

export function PracticeAccess({ children }) {
  const { pathname } = useLocation();
  const { loaded, can } = usePracticePerms();
  const feature = featureForPath(pathname);
  if (!feature) return children;
  if (!loaded) return <PracticeShell withRail={false}><div className="p-8 text-sm text-slate-500">Loading…</div></PracticeShell>;
  if (can(feature, "view")) return children;
  return (
    <PracticeShell withRail={false}>
      <div className="rounded border border-slate-200 bg-white px-8 py-16 text-center" data-testid="practice-access-denied">
        <ShieldOff size={40} className="mx-auto text-slate-400" />
        <h2 className="mt-4 text-xl font-bold text-slate-800">You don't have access to {feature}</h2>
        <p className="mt-1 text-sm text-slate-600">Your security role doesn't allow viewing this section. Ask an administrator to update your role.</p>
      </div>
    </PracticeShell>
  );
}
