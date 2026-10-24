import { ChevronDown, LayoutDashboard } from "lucide-react";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { PracticeStatTiles, PracticeQuickCreate, PracticeGetStarted } from "@/components/practice/PracticeDashboardBlocks";
import { PracticeRecentActivity } from "@/components/practice/PracticeRightRail";

function monthRange() {
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  return `${fmt(new Date(now.getFullYear(), now.getMonth(), 1))} - ${fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0))}`;
}

export default function PracticeHome() {
  return (
    <PracticeShell withRail>
      <div className="space-y-5" data-testid="practice-home">
        <div className="flex items-center gap-3">
          <LayoutDashboard size={26} className="text-slate-500" strokeWidth={1.5} />
          <h1 className="text-2xl font-bold text-slate-800">Dashboard</h1>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <span className="font-medium">Date Range:</span>
          <button type="button" data-testid="practice-date-range"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-3 py-0.5 text-xs font-medium">
            {monthRange()} <ChevronDown size={12} />
          </button>
        </div>
        <PracticeStatTiles />
        <PracticeQuickCreate />
        <PracticeGetStarted />
        <PracticeRecentActivity />
      </div>
    </PracticeShell>
  );
}
