import { Navigate } from "react-router-dom";
import { LayoutDashboard, ChevronDown } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PracticeTopNav } from "@/components/practice/PracticeTopNav";
import { PracticeStatTiles, PracticeQuickCreate, PracticeGetStarted } from "@/components/practice/PracticeDashboardBlocks";
import { PracticeRecentActivity, PracticeRightRail } from "@/components/practice/PracticeRightRail";

function monthRange() {
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  return `${fmt(new Date(now.getFullYear(), now.getMonth(), 1))} - ${fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0))}`;
}

export default function PracticeHome() {
  const { user } = useAuth();
  if (user?.role !== "superadmin") return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-white text-slate-800 flex flex-col" data-testid="practice-home">
      <PracticeTopNav user={user} />
      <div className="flex-1 grid grid-cols-1 xl:grid-cols-[1fr_460px] gap-6 px-6 py-5">
        <main className="space-y-5 min-w-0">
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
        </main>
        <PracticeRightRail />
      </div>
      <footer className="px-6 py-3 text-xs text-slate-500 border-t border-slate-100">
        {new Date().getFullYear()} © Practice | <span className="text-[#1E88E5]">Terms of Service</span> | <span className="text-[#1E88E5]">Privacy Policy</span> | <span className="text-[#1E88E5]">What's New?</span>
      </footer>
    </div>
  );
}
